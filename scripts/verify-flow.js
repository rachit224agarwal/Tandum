const { io } = require("socket.io-client");

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";

async function main() {
  const created = await postJson("/api/sessions", {
    commandKey: "shell",
    term: { cols: 90, rows: 24 }
  });
  const sessionId = created.id;
  const firstClient = io(BASE_URL, { transports: ["websocket"] });
  const secondClient = io(BASE_URL, { transports: ["websocket"] });

  try {
    const firstState = onceEvent(firstClient, "session:state");
    firstClient.emit("session:join", { sessionId });
    const firstPayload = await firstState;

    if (!firstPayload.viewer.isController) {
      throw new Error("First viewer did not become controller.");
    }

    const secondState = onceEvent(secondClient, "session:state");
    secondClient.emit("session:join", { sessionId });
    const secondPayload = await secondState;

    if (secondPayload.viewer.isController) {
      throw new Error("Second viewer unexpectedly became controller.");
    }

    const requestNotice = onceEvent(firstClient, "control:requested");
    secondClient.emit("control:request", { sessionId });
    const requestPayload = await requestNotice;

    const stateUpdateOnFirst = onceEvent(firstClient, "session:state:update");
    const stateUpdateOnSecond = onceEvent(secondClient, "session:state:update");
    firstClient.emit("control:grant", {
      sessionId,
      requesterId: requestPayload.requesterId
    });

    const [updatedFirst, updatedSecond] = await Promise.all([
      stateUpdateOnFirst,
      stateUpdateOnSecond
    ]);

    if (updatedFirst.controllerId !== secondPayload.viewer.socketId) {
      throw new Error("Control was not transferred to the requester.");
    }

    if (updatedSecond.controllerId !== secondPayload.viewer.socketId) {
      throw new Error("Second viewer did not receive controller update.");
    }

    const forked = onceEvent(secondClient, "session:forked");
    secondClient.emit("session:fork", { sessionId });
    const forkedSession = await forked;

    if (!forkedSession.id || forkedSession.id === sessionId) {
      throw new Error("Fork did not create a distinct session.");
    }

    console.log("Verified session join, control handoff, and fork flow.");
  } finally {
    firstClient.disconnect();
    secondClient.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

function onceEvent(socket, eventName) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, onEvent);
      socket.off("session:error", onError);
      reject(new Error(`Timed out waiting for ${eventName}.`));
    }, 5000);

    const onEvent = (payload) => {
      clearTimeout(timeout);
      socket.off("session:error", onError);
      resolve(payload);
    };

    const onError = (payload) => {
      clearTimeout(timeout);
      socket.off(eventName, onEvent);
      reject(new Error(payload?.message || `Received session:error while waiting for ${eventName}.`));
    };

    socket.once(eventName, onEvent);
    socket.once("session:error", onError);
  });
}

async function postJson(pathname, payload) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Request failed for ${pathname}.`);
  }

  return data;
}
