const path = require("path");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const pty = require("node-pty");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BUFFER_CHARS = Number(process.env.MAX_BUFFER_CHARS || 120000);
const DEFAULT_TERM = {
  cols: 120,
  rows: 32
};
const SHELL_PATTERN = /(^|\/)(ba|z|fi|c|tc|k)?sh$/i;

// Why: keep the demo safe by only allowing explicitly approved commands.
const ALLOWED_COMMANDS = buildAllowedCommands(process.env.ALLOWED_COMMANDS);
const sessions = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    sessions: sessions.size,
    allowedCommands: Array.from(ALLOWED_COMMANDS.keys())
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    allowedCommands: Array.from(ALLOWED_COMMANDS.keys())
  });
});

app.get("/api/sessions/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

  return res.json(serializeSession(session));
});

app.post("/api/sessions", (req, res) => {
  try {
    const commandKey = String(req.body.commandKey || "").trim();
    const requestedTerm = normalizeTermSize(req.body.term);
    const session = createSession({
      commandKey,
      term: requestedTerm
    });

    return res.status(201).json(serializeSession(session));
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      error: error.message || "Unable to create session."
    });
  }
});

io.on("connection", (socket) => {
  // Why: centralize socket failures so malformed events cannot crash the demo server.
  const safely = (handler) => async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      socket.emit("session:error", { message: error.message || "Something went wrong." });
    }
  };

  socket.on("session:join", safely(async ({ sessionId }) => {
    const session = getSessionOrThrow(sessionId);
    const previousSessionId = socket.data.sessionId;

    if (previousSessionId && previousSessionId !== sessionId) {
      leaveSession(socket, previousSessionId);
    }

    socket.join(sessionId);
    socket.data.sessionId = sessionId;
    session.participants.set(socket.id, {
      socketId: socket.id,
      joinedAt: Date.now()
    });

    if (!session.controllerId) {
      session.controllerId = socket.id;
    }

    socket.emit("session:state", buildSocketState(session, socket.id));
    io.to(sessionId).emit("session:presence", buildPresenceState(session));
  }));

  socket.on("session:input", safely(async ({ sessionId, data }) => {
    const session = getSessionOrThrow(sessionId);

    if (socket.id !== session.controllerId) {
      throw new Error("Only the controller can send input.");
    }

    if (typeof data !== "string" || data.length > 5000) {
      throw new Error("Invalid terminal input.");
    }

    session.pty.write(data);
  }));

  socket.on("session:resize", safely(async ({ sessionId, cols, rows }) => {
    const session = getSessionOrThrow(sessionId);

    if (socket.id !== session.controllerId) {
      throw new Error("Only the controller can resize the terminal.");
    }

    const safeCols = clampNumber(cols, 40, 220, DEFAULT_TERM.cols);
    const safeRows = clampNumber(rows, 12, 80, DEFAULT_TERM.rows);

    session.term = { cols: safeCols, rows: safeRows };
    session.pty.resize(safeCols, safeRows);
  }));

  socket.on("control:request", safely(async ({ sessionId }) => {
    const session = getSessionOrThrow(sessionId);

    if (!session.participants.has(socket.id)) {
      throw new Error("Join the session before requesting control.");
    }

    if (session.controllerId === socket.id) {
      throw new Error("You already control this session.");
    }

    session.pendingControllerId = socket.id;

    if (session.controllerId) {
      io.to(session.controllerId).emit("control:requested", {
        requesterId: socket.id
      });
    }

    io.to(sessionId).emit("session:presence", buildPresenceState(session));
  }));

  socket.on("control:grant", safely(async ({ sessionId, requesterId }) => {
    const session = getSessionOrThrow(sessionId);

    if (socket.id !== session.controllerId) {
      throw new Error("Only the current controller can grant control.");
    }

    if (!session.participants.has(requesterId)) {
      throw new Error("Requested viewer is no longer connected.");
    }

    transferControl(session, requesterId);
    io.to(sessionId).emit("session:state:update", buildSessionStateUpdate(session));
    io.to(sessionId).emit("session:presence", buildPresenceState(session));
  }));

  socket.on("control:deny", safely(async ({ sessionId }) => {
    const session = getSessionOrThrow(sessionId);

    if (socket.id !== session.controllerId) {
      throw new Error("Only the current controller can deny control.");
    }

    session.pendingControllerId = null;
    io.to(sessionId).emit("session:presence", buildPresenceState(session));
  }));

  socket.on("session:fork", safely(async ({ sessionId }) => {
    const session = getSessionOrThrow(sessionId);
    const forkedSession = createSession({
      commandKey: session.commandKey,
      term: session.term,
      transcriptSeed: session.buffer
    });

    socket.emit("session:forked", serializeSession(forkedSession));
  }));

  socket.on("disconnect", () => {
    if (socket.data.sessionId) {
      leaveSession(socket, socket.data.sessionId);
    }
  });
});

if (require.main === module) {
  server.on("error", (error) => {
    console.error(`Server failed to start: ${error.message}`);
  });

  server.listen(PORT, HOST, () => {
    console.log(`Agent Harness listening on http://${HOST}:${PORT}`);
  });
}

// Why: parse a simple env var format so the demo owner can lock commands down quickly.
function buildAllowedCommands(rawValue) {
  const defaultShell = process.env.SHELL || "/bin/bash";
  const source = rawValue && rawValue.trim()
    ? rawValue
    : `shell:${defaultShell}`;

  return new Map(
    source.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separatorIndex = entry.indexOf(":");
        const key = entry.slice(0, separatorIndex).trim();
        const command = entry.slice(separatorIndex + 1).trim();

        return [key, parseCommandSpec(command)];
      })
      .filter(([key, spec]) => key && spec.file)
  );
}

// Why: create one consistent in-memory model for API responses and socket updates.
function createSession({ commandKey, term, transcriptSeed = "" }) {
  const commandSpec = ALLOWED_COMMANDS.get(commandKey);

  if (!commandSpec) {
    const error = new Error("Command is not allowed.");
    error.statusCode = 400;
    throw error;
  }

  const sessionId = createId();
  const workingDirectory = process.cwd();
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor"
  };
  let ptyProcess;

  try {
    ptyProcess = pty.spawn(commandSpec.file, commandSpec.args, {
      name: "xterm-256color",
      cols: term.cols,
      rows: term.rows,
      cwd: workingDirectory,
      env
    });
  } catch (_error) {
    const error = new Error(`Unable to launch "${commandSpec.display}". Check ALLOWED_COMMANDS for an installed binary.`);
    error.statusCode = 400;
    throw error;
  }
  const session = {
    id: sessionId,
    commandKey,
    executable: commandSpec.display,
    createdAt: Date.now(),
    term,
    participants: new Map(),
    controllerId: null,
    pendingControllerId: null,
    buffer: "",
    transcriptSeed,
    pty: ptyProcess
  };

  sessions.set(sessionId, session);

  if (transcriptSeed) {
    const seedBlock = buildSeedBlock(transcriptSeed, commandSpec);
    session.buffer = trimBuffer(seedBlock);

    if (!isShellCommand(commandSpec.file)) {
      ptyProcess.write(`${transcriptSeed}\r`);
    }
  }

  ptyProcess.onData((chunk) => {
    session.buffer = trimBuffer(session.buffer + chunk);
    io.to(session.id).emit("session:output", { data: chunk });
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    const summary = `\r\n[process exited: code=${exitCode} signal=${signal || "none"}]\r\n`;
    session.buffer = trimBuffer(session.buffer + summary);
    io.to(session.id).emit("session:output", { data: summary });
    io.to(session.id).emit("session:ended", { exitCode, signal: signal || null });
  });

  return session;
}

// Why: ensure reconnects and late joins get a complete snapshot immediately.
function buildSocketState(session, socketId) {
  return {
    session: serializeSession(session),
    scrollback: session.buffer,
    viewer: {
      socketId,
      isController: session.controllerId === socketId
    },
    presence: buildPresenceState(session)
  };
}

// Why: send lightweight controller changes without replaying the full scrollback snapshot.
function buildSessionStateUpdate(session) {
  return {
    sessionId: session.id,
    controllerId: session.controllerId,
    pendingControllerId: session.pendingControllerId
  };
}

// Why: keep every client’s presence strip derived from one authoritative server view.
function buildPresenceState(session) {
  return {
    controllerId: session.controllerId,
    pendingControllerId: session.pendingControllerId,
    participantCount: session.participants.size,
    participants: Array.from(session.participants.values()).map((participant) => ({
      socketId: participant.socketId,
      joinedAt: participant.joinedAt,
      isController: participant.socketId === session.controllerId,
      isPending: participant.socketId === session.pendingControllerId
    }))
  };
}

// Why: expose only the session metadata the browser needs to join and render state.
function serializeSession(session) {
  return {
    id: session.id,
    commandKey: session.commandKey,
    executable: session.executable,
    createdAt: session.createdAt,
    term: session.term,
    shareUrl: `/?session=${session.id}`,
    controllerId: session.controllerId,
    pendingControllerId: session.pendingControllerId,
    participantCount: session.participants.size,
    hasTranscriptSeed: Boolean(session.transcriptSeed)
  };
}

// Why: fail fast on invalid session IDs before any socket or PTY work happens.
function getSessionOrThrow(sessionId) {
  const session = sessions.get(String(sessionId || ""));

  if (!session) {
    throw new Error("Session not found.");
  }

  return session;
}

// Why: cleanly remove disconnected viewers and keep control ownership deterministic.
function leaveSession(socket, sessionId) {
  const session = sessions.get(sessionId);

  if (!session) {
    return;
  }

  session.participants.delete(socket.id);

  if (session.pendingControllerId === socket.id) {
    session.pendingControllerId = null;
  }

  if (session.controllerId === socket.id) {
    const nextControllerId = session.participants.keys().next().value || null;
    transferControl(session, nextControllerId);
  }

  socket.leave(sessionId);
  socket.data.sessionId = null;
  io.to(sessionId).emit("session:state:update", buildSessionStateUpdate(session));
  io.to(sessionId).emit("session:presence", buildPresenceState(session));
}

function transferControl(session, nextControllerId) {
  session.controllerId = nextControllerId || null;
  session.pendingControllerId = null;
}

// Why: bound scrollback growth so a long-running demo session does not leak memory.
function trimBuffer(buffer) {
  if (buffer.length <= MAX_BUFFER_CHARS) {
    return buffer;
  }

  return buffer.slice(buffer.length - MAX_BUFFER_CHARS);
}

// Why: clamp browser-reported dimensions into safe PTY bounds before spawning or resizing.
function normalizeTermSize(term) {
  return {
    cols: clampNumber(term?.cols, 40, 220, DEFAULT_TERM.cols),
    rows: clampNumber(term?.rows, 12, 80, DEFAULT_TERM.rows)
  };
}

// Why: centralize number sanitization for every dimension value coming from the client.
function clampNumber(value, min, max, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(number)));
}

// Why: keep share links short enough to read and paste comfortably during a live demo.
function createId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

// Why: allow a safe lightweight command+args format without opening arbitrary shell parsing.
function parseCommandSpec(command) {
  const parts = String(command || "").match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const cleaned = parts.map((part) => part.replace(/^"(.*)"$/, "$1"));

  return {
    file: cleaned[0] || "",
    args: cleaned.slice(1),
    display: cleaned.join(" ")
  };
}

// Why: make forked sessions visibly inherit transcript context even when stdin seeding differs by command type.
function buildSeedBlock(transcriptSeed, commandSpec) {
  const note = isShellCommand(commandSpec.file)
    ? "[Harness seed visible below for reference. Shell sessions do not auto-run transcript lines.]"
    : "[Harness seed below was also sent to the forked process stdin.]";

  return `\r\n${note}\r\n[Harness seed from parent session]\r\n${transcriptSeed}\r\n[/Harness seed]\r\n`;
}

// Why: shells should not receive raw transcript replay because that can execute prior output as commands.
function isShellCommand(file) {
  return SHELL_PATTERN.test(path.basename(String(file || "")));
}

module.exports = {
  app,
  server
};
