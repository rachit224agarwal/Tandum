const socket = io({
  autoConnect: true,
  transports: ["websocket"]
});

const state = {
  session: null,
  allowedCommands: [],
  viewerSocketId: null,
  isController: false,
  presence: {
    controllerId: null,
    pendingControllerId: null,
    participantCount: 0,
    participants: []
  }
};

const elements = {
  launchForm: document.getElementById("launch-form"),
  commandSelect: document.getElementById("command-select"),
  colsInput: document.getElementById("cols-input"),
  rowsInput: document.getElementById("rows-input"),
  statusMessage: document.getElementById("status-message"),
  helperMessage: document.getElementById("helper-message"),
  sessionLabel: document.getElementById("session-label"),
  rolePill: document.getElementById("role-pill"),
  presenceCount: document.getElementById("presence-count"),
  seedLabel: document.getElementById("seed-label"),
  presenceStrip: document.getElementById("presence-strip"),
  copyLinkButton: document.getElementById("copy-link-button"),
  requestControlButton: document.getElementById("request-control-button"),
  forkSessionButton: document.getElementById("fork-session-button")
};

const terminal = new Terminal({
  cursorBlink: true,
  convertEol: true,
  fontFamily: "IBM Plex Mono, monospace",
  fontSize: 14,
  theme: {
    background: "#060d17",
    foreground: "#edf5ff",
    cursor: "#61e7c0",
    black: "#07111f",
    green: "#61e7c0",
    brightGreen: "#9ef7dd",
    blue: "#56a7ff",
    brightBlue: "#9fc8ff",
    yellow: "#ffd166",
    white: "#edf5ff"
  }
});
const fitAddon = new FitAddon.FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(document.getElementById("terminal"));
fitAddon.fit();

terminal.onData((data) => {
  if (!state.session || !state.isController) {
    return;
  }

  socket.emit("session:input", {
    sessionId: state.session.id,
    data
  });
});

window.addEventListener("resize", () => {
  fitAddon.fit();
  syncTerminalSize();
});

elements.launchForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        commandKey: elements.commandSelect.value,
        term: readTermSize()
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Unable to create session.");
    }

    connectToSession(payload.id, `New ${payload.commandKey} session is live.`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.copyLinkButton.addEventListener("click", async () => {
  if (!state.session) {
    setStatus("Start or join a session before copying the share link.", true);
    return;
  }

  const shareUrl = new URL(state.session.shareUrl, window.location.origin).toString();

  try {
    await navigator.clipboard.writeText(shareUrl);
    setStatus("Share link copied. Teammates can join instantly from another tab or device.");
  } catch (_error) {
    setStatus(`Copy failed. Manual link: ${shareUrl}`, true);
  }
});

elements.requestControlButton.addEventListener("click", () => {
  if (!state.session) {
    setStatus("Join a session first.", true);
    return;
  }

  if (state.isController) {
    setStatus("You already control this session.");
    return;
  }

  socket.emit("control:request", { sessionId: state.session.id });
  setStatus("Control request sent to the current controller.");
});

elements.forkSessionButton.addEventListener("click", () => {
  if (!state.session) {
    setStatus("Join a session first.", true);
    return;
  }

  socket.emit("session:fork", { sessionId: state.session.id });
  setStatus("Forking a fresh branch with the visible transcript seeded in.");
});

socket.on("connect", async () => {
  try {
    await loadConfig();
  } catch (error) {
    setStatus("Unable to load app configuration.", true);
    setHelper(error.message || "Check that the server is running and reload the page.");
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session");

  if (sessionId) {
    connectToSession(sessionId, "Connected through a shared session link.");
  } else {
    setStatus("Pick an allowed command to launch the demo.");
  }
});

socket.on("session:state", ({ session, scrollback, viewer, presence }) => {
  state.session = session;
  state.viewerSocketId = viewer.socketId;
  state.isController = viewer.isController;
  state.presence = presence;

  window.history.replaceState({}, "", session.shareUrl);
  terminal.reset();
  terminal.write(scrollback || "");
  fitAddon.fit();
  syncTerminalSize();
  setHelper(
    session.hasTranscriptSeed
      ? "This branch includes a visible transcript seed from its parent session."
      : "Only the active controller can type or resize the shared terminal."
  );
  render();
});

socket.on("session:output", ({ data }) => {
  terminal.write(data);
});

socket.on("session:presence", (presence) => {
  state.presence = presence;
  render();
});

socket.on("session:state:update", ({ controllerId, pendingControllerId }) => {
  state.presence.controllerId = controllerId;
  state.presence.pendingControllerId = pendingControllerId;
  state.isController = controllerId === state.viewerSocketId;
  setHelper(
    state.session
      ? state.isController
        ? "You control input and terminal size for everyone watching."
        : "You are in read-only mode until control is granted."
      : ""
  );
  render();
});

socket.on("control:requested", ({ requesterId }) => {
  const shouldGrant = window.confirm("A viewer requested control. Grant it now?");

  if (shouldGrant && state.session) {
    socket.emit("control:grant", {
      sessionId: state.session.id,
      requesterId
    });
    setStatus("Control transferred live.");
  } else if (state.session) {
    socket.emit("control:deny", {
      sessionId: state.session.id
    });
    setStatus("Control request denied.");
  }
});

socket.on("session:forked", (session) => {
  connectToSession(session.id, "Fork created. You are now in your own branch session.");
});

socket.on("session:ended", ({ exitCode, signal }) => {
  setStatus(`Session ended with exit code ${exitCode}${signal ? ` and signal ${signal}` : ""}.`, true);
});

socket.on("session:error", ({ message }) => {
  setStatus(message || "Something went wrong.", true);
});

async function loadConfig() {
  const response = await fetch("/api/config");
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Unable to load allowed commands.");
  }

  state.allowedCommands = payload.allowedCommands || [];
  renderCommandOptions();
}

// Why: keep the launcher truthful about whether the backend has any demo-safe commands configured.
function renderCommandOptions() {
  elements.commandSelect.innerHTML = "";

  state.allowedCommands.forEach((commandKey) => {
    const option = document.createElement("option");
    option.value = commandKey;
    option.textContent = commandKey;
    elements.commandSelect.appendChild(option);
  });

  const hasCommands = state.allowedCommands.length > 0;
  elements.commandSelect.disabled = !hasCommands;
  elements.launchForm.querySelector("button[type='submit']").disabled = !hasCommands;

  if (!hasCommands) {
    setStatus("No allowed commands are configured on the server.", true);
    setHelper("Set ALLOWED_COMMANDS before the demo, then refresh this page.");
  }
}

// Why: validate the session link before joining so broken links fail with a friendly message.
async function connectToSession(sessionId, message) {
  try {
    const response = await fetch(`/api/sessions/${sessionId}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Session not found.");
    }

    socket.emit("session:join", { sessionId });
    setStatus(message || `Joined session ${sessionId}.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

// Why: read launch sizing from the form once so session creation stays consistent with the current UI.
function readTermSize() {
  return {
    cols: Number(elements.colsInput.value || 120),
    rows: Number(elements.rowsInput.value || 32)
  };
}

// Why: only the active controller should drive PTY dimensions for every connected viewer.
function syncTerminalSize() {
  if (!state.session || !state.isController) {
    return;
  }

  const cols = terminal.cols;
  const rows = terminal.rows;

  socket.emit("session:resize", {
    sessionId: state.session.id,
    cols,
    rows
  });
}

// Why: update the hero stats and action states from one shared client-side session model.
function render() {
  const sessionId = state.session ? state.session.id : "Not connected";
  elements.sessionLabel.textContent = sessionId;
  elements.rolePill.textContent = state.isController ? "Controller" : "Viewer";
  elements.presenceCount.textContent = `${state.presence.participantCount} live`;
  elements.seedLabel.textContent = state.session?.hasTranscriptSeed ? "Seeded" : "None";
  elements.requestControlButton.disabled = !state.session || state.isController;
  elements.forkSessionButton.disabled = !state.session;
  elements.copyLinkButton.disabled = !state.session;
  elements.rolePill.style.background = state.isController ? "rgba(97, 231, 192, 0.18)" : "rgba(86, 167, 255, 0.16)";
  elements.rolePill.style.color = state.isController ? "#61e7c0" : "#9fc8ff";

  renderPresence();
}

// Why: render presence chips from server state so everyone sees the same controller and request status.
function renderPresence() {
  elements.presenceStrip.innerHTML = "";

  if (!state.session) {
    return;
  }

  state.presence.participants.forEach((participant, index) => {
    const chip = document.createElement("div");
    chip.className = "presence-chip";

    if (participant.socketId === state.presence.controllerId) {
      chip.classList.add("active");
    }

    if (participant.socketId === state.presence.pendingControllerId) {
      chip.classList.add("pending");
    }

    const label = participant.socketId === state.viewerSocketId
      ? "You"
      : `Viewer ${index + 1}`;

    chip.innerHTML = `<strong>${label}</strong>${participant.isController ? " controlling" : participant.isPending ? " requesting" : " watching"}`;
    elements.presenceStrip.appendChild(chip);
  });
}

// Why: keep the main status line focused on the single most important action or error for the demo.
function setStatus(message, isError = false) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.style.color = isError ? "#ffd7cf" : "#98adca";
}

// Why: use a secondary message line for guidance without crowding out primary status changes.
function setHelper(message) {
  elements.helperMessage.textContent = message || "";
}
