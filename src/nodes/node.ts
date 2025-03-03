import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { NodeState, Value } from "../types";

type MsgType = "R" | "P";

interface MsgPayload {
  type: MsgType;
  round: number;
  val: Value;
  sender: number;
}

export async function node(
  nodeId: number,
  N: number,
  F: number,
  initialValue: Value,
  isFaulty: boolean,
  nodesAreReady: () => boolean,
  setNodeIsReady: (index: number) => void
) {
  const app = express();
  app.use(express.json());
  app.use(bodyParser.json());

  let state: NodeState = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 1,
  };

  let inbox: {
    R: { [round: number]: { [value: string]: number } };
    P: { [round: number]: { [value: string]: number } };
  } = {
    R: {},
    P: {},
  };

  let consensusRunning = false;
  const toleranceThreshold = Math.floor((N - 1) / 2);
  const exceedingFaultLimit = F > toleranceThreshold;

  function prepareInbox(round: number) {
    if (!inbox.R[round]) inbox.R[round] = { "0": 0, "1": 0, "?": 0 };
    if (!inbox.P[round]) inbox.P[round] = { "0": 0, "1": 0, "?": 0 };
  }

  async function sendToAll(msg: MsgPayload) {
    if (state.killed || isFaulty) return;
    while (!nodesAreReady()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (state.killed) return;
    }
    for (let i = 0; i < N; i++) {
      if (i !== nodeId && !state.killed) {
        try {
          await fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(msg),
          });
        } catch (_) {}
      }
    }
  }

  async function consensusLoop() {
    if (state.killed || isFaulty || !consensusRunning) return;
    if (state.decided && !exceedingFaultLimit) return;
  
    const round = state.k!;
    prepareInbox(round);
  
    if (state.x !== null) inbox.R[round][state.x.toString()]++;
  
    await sendToAll({ type: "R", round, val: state.x as Value, sender: nodeId });
    await waitForMessages(round, "R", N - F);
    if (state.killed || !consensusRunning) return;
  
    let confirmVal: Value = "?";
    if (inbox.R[round]["0"] > Math.floor(N / 2)) confirmVal = 0;
    else if (inbox.R[round]["1"] > Math.floor(N / 2)) confirmVal = 1;
  
    inbox.P[round][confirmVal.toString()]++;
    await sendToAll({ type: "P", round, val: confirmVal, sender: nodeId });
    await waitForMessages(round, "P", N - F);
    if (state.killed || !consensusRunning) return;
  
    if (round >= 2) {
      let finalValue: Value = "?";
      if (inbox.P[round]["0"] > inbox.P[round]["1"]) {
        finalValue = 0;
      } else if (inbox.P[round]["1"] > inbox.P[round]["0"]) {
        finalValue = 1;
      }
  
      if (finalValue !== "?") {
        state.x = finalValue;
        state.decided = true;
        return;
      } else {
        state.x = (round % 2) as Value;
      }
    }
  
    if (!state.decided) {
      state.k = round + 1;
      setTimeout(consensusLoop, 50);
    }
  }
  
  app.get("/status", (req, res) => {
    res.status(isFaulty ? 500 : 200).send(isFaulty ? "faulty" : "live");
  });

  app.post("/message", (req, res) => {
    if (state.killed || isFaulty) return res.status(200).send();
    const msg: MsgPayload = req.body;
    if (!msg || !msg.type || msg.round === undefined || msg.val === undefined) {
      return res.status(400).send("Invalid message format");
    }
    prepareInbox(msg.round);
    inbox[msg.type][msg.round][msg.val.toString()]++;
    return res.status(200).send("Message received");
  });

  app.get("/start", (req, res) => {
    if (isFaulty || state.killed) return res.status(500).send("Node is faulty or killed");
    consensusRunning = true;
    if (!state.decided) setTimeout(consensusLoop, 50);
    return res.status(200).send("Consensus started");
  });

  app.get("/stop", (req, res) => {
    consensusRunning = false;
    state.killed = true;
    res.status(200).send("Consensus stopped");
  });

  app.get("/getState", (req, res) => {
    if (isFaulty) {
      return res.status(200).json({
        killed: state.killed,
        x: null,
        decided: null,
        k: null
      });
    }
    if (exceedingFaultLimit) {
      return res.status(200).json({
        killed: state.killed,
        x: state.x,
        decided: false,
        k: Math.max(state.k || 0, 11)
      });
    }
    return res.status(200).json(state);
  });

  async function waitForMessages(round: number, msgType: MsgType, minCount: number) {
    const start = Date.now();
    while (Date.now() - start < 20) { // Max wait time 20ms
      if ((inbox[msgType][round]?.["0"] || 0) + (inbox[msgType][round]?.["1"] || 0) >= minCount) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  const server = app.listen(BASE_NODE_PORT + nodeId, () => {
    console.log(`Node ${nodeId} listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}
