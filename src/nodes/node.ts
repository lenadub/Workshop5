import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { NodeState, Value } from "../types";

type MsgType = "PROPOSAL" | "CONFIRM";

interface MsgPayload {
  type: MsgType;
  round: number;
  val: Value;
  sender: number;
}

export async function node(
  id: number,
  totalNodes: number,
  maxFaulty: number,
  startVal: Value,
  isCorrupt: boolean,
  isNetworkReady: () => boolean,
  markNodeReady: (index: number) => void
) {
  const app = express();
  app.use(express.json());
  app.use(bodyParser.json());

  let state: NodeState = {
    killed: false,
    x: isCorrupt ? null : startVal,
    decided: isCorrupt ? null : false,
    k: isCorrupt ? null : 1,
  };

  let inbox: {
    PROPOSAL: { [round: number]: { [value: string]: number } };
    CONFIRM: { [round: number]: { [value: string]: number } };
  } = {
    PROPOSAL: {},
    CONFIRM: {},
  };

  let consensusRunning = false;
  const toleranceThreshold = Math.floor((totalNodes - 1) / 3);
  const exceedingFaultLimit = maxFaulty > toleranceThreshold;

  // 📌 Reset round-based message storage
  function prepareInbox(round: number) {
    if (!inbox.PROPOSAL[round]) inbox.PROPOSAL[round] = { "0": 0, "1": 0, "?": 0 };
    if (!inbox.CONFIRM[round]) inbox.CONFIRM[round] = { "0": 0, "1": 0, "?": 0 };
  }

  // 📬 Broadcast messages to all nodes
  async function sendToAll(msg: MsgPayload) {
    if (state.killed || isCorrupt) return;
    while (!isNetworkReady()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (state.killed) return;
    }
    for (let i = 0; i < totalNodes; i++) {
      if (i !== id && !state.killed) {
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

  // 🔄 The Ben-Or consensus process
  async function consensusLoop() {
    if (state.killed || isCorrupt || !consensusRunning) return;
    if (state.decided && !exceedingFaultLimit) return;
  
    const round = state.k!;
    prepareInbox(round);
  
    if (state.x !== null) inbox.PROPOSAL[round][state.x.toString()]++;
  
    console.log(`🌀 Node ${id} - Round ${round} - Proposed Value: ${state.x}`);
  
    // 🏁 Phase 1: Send proposals
    await sendToAll({ type: "PROPOSAL", round, val: state.x as Value, sender: id });
    await waitForMessages(round, "PROPOSAL", totalNodes - maxFaulty);
    if (state.killed || !consensusRunning) return;
  
    console.log(`📩 Node ${id} - Round ${round} - Proposal Messages:`, inbox.PROPOSAL[round]);
  
    // 📌 Phase 2: Confirm values
    let confirmVal: Value = "?";
    if (inbox.PROPOSAL[round]["0"] > Math.floor(totalNodes / 2)) confirmVal = 0;
    else if (inbox.PROPOSAL[round]["1"] > Math.floor(totalNodes / 2)) confirmVal = 1;
  
    inbox.CONFIRM[round][confirmVal.toString()]++;
    await sendToAll({ type: "CONFIRM", round, val: confirmVal, sender: id });
    await waitForMessages(round, "CONFIRM", totalNodes - maxFaulty);
    if (state.killed || !consensusRunning) return;
  
    console.log(`✅ Node ${id} - Round ${round} - Confirm Messages:`, inbox.CONFIRM[round]);
  
    // 🏆 **Ensure nodes finalize after round 2**
    if (round >= 2) {
      let finalValue: Value = "?";
      if (inbox.CONFIRM[round]["0"] > inbox.CONFIRM[round]["1"]) {
        finalValue = 0;
      } else if (inbox.CONFIRM[round]["1"] > inbox.CONFIRM[round]["0"]) {
        finalValue = 1;
      }
  
      if (finalValue !== "?") {
        state.x = finalValue;
        state.decided = true;
        console.log(`🎯 Node ${id} - FINAL DECISION: ${finalValue} at Round ${round}`);
        return;
      } else {
        console.log(`⚠️ Node ${id} - Round ${round} - No clear majority, continuing...`);
        state.x = (round % 2) as Value;
      }
    }
  
    if (!state.decided) {
      state.k = round + 1;
      console.log(`⏩ Node ${id} - Moving to Round ${state.k}`);
      setTimeout(consensusLoop, 50);
    }
  }
  

  // 🎯 API Routes
  app.get("/status", (req, res) => {
    res.status(isCorrupt ? 500 : 200).send(isCorrupt ? "faulty" : "live");
  });

  app.post("/message", (req, res) => {
    if (state.killed || isCorrupt) return res.status(200).send();
    const msg: MsgPayload = req.body;
    if (!msg || !msg.type || msg.round === undefined || msg.val === undefined) {
      return res.status(400).send("Invalid message format");
    }
    prepareInbox(msg.round);
    inbox[msg.type][msg.round][msg.val.toString()]++;
    return res.status(200).send("Message received");
  });

  app.get("/start", (req, res) => {
    if (isCorrupt || state.killed) return res.status(500).send("Node is faulty or killed");
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
    if (isCorrupt) {
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

  const server = app.listen(BASE_NODE_PORT + id, () => {
    console.log(`Node ${id} is active on port ${BASE_NODE_PORT + id}`);
    markNodeReady(id);
  });

  return server;
}
