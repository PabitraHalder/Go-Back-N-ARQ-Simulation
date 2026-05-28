// ============================================================
//  Go-Back-N ARQ — Bounded Sequence Numbers Protocol Engine
// ============================================================

class ARQTimer {
  constructor(durationInSeconds, displayId, progressBarId, onTimeoutCallback) {
    this.duration = durationInSeconds * 1000;
    this.remainingTime = this.duration;
    this.timerId = null;
    this.displayEl = document.getElementById(displayId);
    this.progressBarEl = document.getElementById(progressBarId);
    this.onTimeout = onTimeoutCallback;
  }
  start() {
    this.stop();
    this.remainingTime = this.duration;
    this.timerId = setInterval(() => {
      this.remainingTime -= 100;
      if (this.remainingTime <= 0) {
        this.remainingTime = 0;
        this.updateUI();
        this.stop();
        if (this.onTimeout) this.onTimeout();
      } else {
        this.updateUI();
      }
    }, 100);
  }
  stop() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }
  reset() {
    this.stop();
    this.remainingTime = this.duration;
    this.updateUI();
  }
  updateUI() {
    const s = (this.remainingTime / 1000).toFixed(1);
    this.displayEl.textContent = `${s}s`;
    const pct = (this.remainingTime / this.duration) * 100;
    this.progressBarEl.style.width = `${pct}%`;
  }
}

// ── Configuration Variables ─────────────────────────────────
let WINDOW_SIZE = 3;
let MAX_SEQ_NUM = WINDOW_SIZE + 1; // Sequence Space size -> WINDOW_SIZE + 1 total values
const TOTAL_PACKETS = 8; // Grid slots to fill up
let FLIGHT_DURATION = 1200; // ms — controlled by the speed slider

// ── Protocol State Tracking Variables ───────────────────────
// (Stored as raw indices 0..7, but mapped to header values 0..3 using % MAX_SEQ_NUM)
let sendBase = 0;
let nextSeq = 0;
let rcvExpect = 0;
let forceLossNext = false;
let isRetransmitting = false;

// ── DOM Collections ────────────────────────────────────────
const senderContainer = document.querySelector(".sender");
const receiverContainer = document.querySelector(".receiver");
const channelArea = document.getElementById("channelArea");
const logBody = document.getElementById("logBody");

const elSendBase = document.getElementById("sendBase");
const elNextSeq = document.getElementById("nextSeq");
const elRcvExpected = document.getElementById("rcvExpected");

const btnSend = document.querySelector(".send-pkt-btn");
const btnLose = document.querySelector(".lose-pkt-btn");
const btnReset = document.querySelector(".reset");

// Create Sliding Windows Elements
const senderWinBox = document.createElement("div");
senderWinBox.className = "sliding-window sender-window";
senderContainer.appendChild(senderWinBox);

const receiverWinBox = document.createElement("div");
receiverWinBox.className = "sliding-window receiver-window";
receiverContainer.appendChild(receiverWinBox);

const senderCells = [];
const receiverCells = [];

// ── Grid Setup Initialization ──────────────────────────────
for (let i = 0; i < TOTAL_PACKETS; i++) {
  const sequenceHeaderLabel = i % MAX_SEQ_NUM;

  const sc = document.createElement("div");
  sc.className = "array-cell";
  sc.setAttribute("data-index", i);
  sc.textContent = `Seq ${sequenceHeaderLabel}`;
  senderContainer.appendChild(sc);
  senderCells.push(sc);

  const rc = document.createElement("div");
  rc.className = "array-cell";
  rc.setAttribute("data-index", i);
  rc.textContent = `-`;
  receiverContainer.appendChild(rc);
  receiverCells.push(rc);
}

const senderTimer = new ARQTimer(10, "timerDisplay", "progressBar", () => {
  const baseHeaderSeq = sendBase % MAX_SEQ_NUM;
  log(
    `TIMEOUT! Frame Header Seq ${baseHeaderSeq} expired. Initiating GBN rollback loop.`,
    "timeout",
  );
  handleGoBackNRetransmission();
});

// ── Sliding Window Position Calculators ────────────────────
function updateSlidingWindows() {
  const baseCell = senderCells[sendBase];
  if (baseCell && sendBase < TOTAL_PACKETS) {
    const targetSpan = Math.min(WINDOW_SIZE, TOTAL_PACKETS - sendBase);
    const lastCellInWin = senderCells[sendBase + targetSpan - 1];

    const topOffset = baseCell.offsetTop;
    const totalHeight =
      lastCellInWin.offsetTop + lastCellInWin.offsetHeight - topOffset;

    senderWinBox.style.top = `${topOffset - 4}px`;
    senderWinBox.style.height = `${totalHeight + 8}px`;
    senderWinBox.style.display = "block";
  } else {
    senderWinBox.style.display = "none";
  }

  const rcvCell = receiverCells[rcvExpect];
  if (rcvCell && rcvExpect < TOTAL_PACKETS) {
    receiverWinBox.style.top = `${rcvCell.offsetTop - 4}px`;
    receiverWinBox.style.height = `${rcvCell.offsetHeight + 8}px`;
    receiverWinBox.style.display = "block";

    receiverCells.forEach((c, idx) => {
      if (idx === rcvExpect) c.classList.add("expected");
      else c.classList.remove("expected");
    });
  } else {
    receiverWinBox.style.display = "none";
  }

  elSendBase.textContent = sendBase % MAX_SEQ_NUM;
  elNextSeq.textContent = nextSeq % MAX_SEQ_NUM;
  elRcvExpected.textContent = rcvExpect % MAX_SEQ_NUM;

  btnSend.disabled =
    nextSeq >= sendBase + WINDOW_SIZE ||
    nextSeq >= TOTAL_PACKETS ||
    isRetransmitting;
}

// ── Protocol Core Functions ────────────────────────────────
function log(msg, type = "info") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logBody.prepend(entry);
}

function getRowY(index) {
  const cellRect = senderCells[index].getBoundingClientRect();
  const chRect = channelArea.getBoundingClientRect();
  return cellRect.top + cellRect.height / 2 - chRect.top - 14;
}

function animateFlight(label, fromRight, targetY, isLost = false) {
  return new Promise((resolve) => {
    const pkt = document.createElement("div");
    pkt.className = `flying-packet ${fromRight ? "ack" : "pkt"}`;
    pkt.textContent = label;
    pkt.style.top = `${targetY}px`;

    const areaWidth = channelArea.offsetWidth;
    pkt.style.left = fromRight ? `${areaWidth}px` : `-80px`;
    channelArea.appendChild(pkt);

    void pkt.offsetWidth;
    pkt.style.transition = `left ${FLIGHT_DURATION}ms linear, opacity 300ms ease`;

    if (isLost) {
      setTimeout(() => {
        pkt.style.left = `${areaWidth / 2 - 30}px`;
        setTimeout(() => {
          pkt.style.opacity = "0";
          setTimeout(() => {
            pkt.remove();
            resolve({ delivered: false });
          }, 300);
        }, 400);
      }, FLIGHT_DURATION * 0.08);
    } else {
      pkt.style.left = fromRight ? `-80px` : `${areaWidth}px`;
      setTimeout(() => {
        pkt.remove();
        resolve({ delivered: true });
      }, FLIGHT_DURATION + 50);
    }
  });
}

// ── Send and Receive Protocol Engine ─────────────────────────
async function sendPacket(packetIndex) {
  if (packetIndex >= TOTAL_PACKETS) return;

  const headerSeqNo = packetIndex % MAX_SEQ_NUM;

  const currentLossTarget = forceLossNext;
  if (currentLossTarget) {
    forceLossNext = false;
    btnLose.classList.remove("reset");
    btnLose.textContent = "Simulate Loss on Next Dispatch";
  }

  log(
    `[Tx] Dispatching Packet. Packet Index: ${packetIndex} -> Header Seq: ${headerSeqNo}`,
    "info",
  );
  senderCells[packetIndex].className = "array-cell sent";

  if (sendBase === packetIndex) {
    senderTimer.start();
  }

  if (packetIndex === nextSeq) nextSeq++;
  updateSlidingWindows();

  const result = await animateFlight(
    `Seq ${headerSeqNo}`,
    false,
    getRowY(packetIndex),
    currentLossTarget,
  );

  if (!result.delivered) {
    log(`[Loss] Packet with Header Seq ${headerSeqNo} dropped!`, "error");
    return;
  }

  // ── Receiver-Side Tracking Engine ──
  const expectedHeaderSeq = rcvExpect % MAX_SEQ_NUM;

  if (headerSeqNo === expectedHeaderSeq) {
    log(
      `[Rx] In-order match! Expected Header Seq ${expectedHeaderSeq} matches received Seq ${headerSeqNo}.`,
      "success",
    );
    receiverCells[rcvExpect].className = "array-cell received";
    receiverCells[rcvExpect].textContent = `Seq ${headerSeqNo} (OK)`;

    rcvExpect++;
    updateSlidingWindows();

    const nextExpectedHeaderAck = rcvExpect % MAX_SEQ_NUM;
    log(
      `[Rx] Generating Cumulative Acknowledgement: ACK ${nextExpectedHeaderAck}`,
      "info",
    );
    const ackResult = await animateFlight(
      `ACK ${nextExpectedHeaderAck}`,
      true,
      getRowY(packetIndex),
    );

    // ── Sender Processing the ACK ──
    if (ackResult.delivered) {
      let matchIndex = -1;
      for (let i = sendBase; i < nextSeq; i++) {
        if ((i + 1) % MAX_SEQ_NUM === nextExpectedHeaderAck) {
          matchIndex = i + 1;
        }
      }

      if (matchIndex > sendBase) {
        log(
          `[Tx] Cumulative ACK ${nextExpectedHeaderAck} received. Acknowledging indices up to ${matchIndex - 1}`,
          "success",
        );
        for (let i = sendBase; i < matchIndex; i++) {
          senderCells[i].className = "array-cell acked";
        }
        sendBase = matchIndex;

        if (sendBase === nextSeq) {
          senderTimer.stop();
          log("Pipeline clear. Stopping tracking timer.", "success");
        } else {
          senderTimer.start();
        }
        updateSlidingWindows();
        checkCompletion();
      }
    }
  } else {
    log(
      `[Rx] Out-of-order Packet discarded! Received Seq ${headerSeqNo} but expected Seq ${expectedHeaderSeq}.`,
      "error",
    );

    const currentHeaderAckRequest = rcvExpect % MAX_SEQ_NUM;
    log(
      `[Rx] Re-sending current Cumulative state: ACK ${currentHeaderAckRequest}`,
      "info",
    );
    await animateFlight(
      `ACK ${currentHeaderAckRequest}`,
      true,
      getRowY(packetIndex),
    );
  }
}

// ── Go-Back-N Retransmission Pipeline Loop ───────────────────
async function handleGoBackNRetransmission() {
  isRetransmitting = true;
  btnSend.disabled = true;

  log(
    `[Retransmit] Pipeline fallback activated. Rolling execution pointer back to index base: ${sendBase}`,
    "timeout",
  );

  for (let i = sendBase; i < nextSeq; i++) {
    senderCells[i].className = "array-cell sent";
  }

  const packetsToResend = [];
  for (let i = sendBase; i < nextSeq; i++) {
    packetsToResend.push(i);
  }

  for (const index of packetsToResend) {
    await sendPacket(index);
  }

  isRetransmitting = false;
  updateSlidingWindows();
}

function checkCompletion() {
  if (sendBase >= TOTAL_PACKETS) {
    log(
      "SUCCESS! All Sequence allocations completed and acknowledged successfully.",
      "success",
    );
    senderTimer.stop();
    btnSend.disabled = true;
    btnLose.disabled = true;
  }
}

// ── Control Event Listeners ─────────────────────────────────
btnSend.addEventListener("click", () => {
  if (nextSeq < sendBase + WINDOW_SIZE && nextSeq < TOTAL_PACKETS) {
    sendPacket(nextSeq);
  }
});

btnLose.addEventListener("click", () => {
  forceLossNext = !forceLossNext;
  if (forceLossNext) {
    btnLose.classList.add("reset");
    btnLose.textContent = "Loss Simulation Active!";
    log("Next packet sent will trigger a simulated loss drop.", "timeout");
  } else {
    btnLose.classList.remove("reset");
    btnLose.textContent = "Simulate Loss on Next Dispatch";
  }
});

btnReset.addEventListener("click", () => resetSimulation());

// ── Speed Slider Event Listener ─────────────────────────────
document.getElementById("speedSlider").addEventListener("input", (e) => {
  FLIGHT_DURATION = Number(e.target.value);
  document.getElementById("speedDisplay").textContent = `${FLIGHT_DURATION}ms`;
});

// ── Window Size Input Event Listener ────────────────────────
document.getElementById("windowSizeInput").addEventListener("change", (e) => {
  const val = Math.max(1, Math.min(8, Number(e.target.value)));
  e.target.value = val;
  if (val === WINDOW_SIZE) return;

  WINDOW_SIZE = val;
  MAX_SEQ_NUM = WINDOW_SIZE + 1;
  document.getElementById("windowSize").textContent = WINDOW_SIZE;

  log(
    `Window size changed to ${WINDOW_SIZE}. Seq space: 0–${MAX_SEQ_NUM - 1}. Resetting simulation.`,
    "timeout",
  );
  resetSimulation();
});

// ── Full In-Place Reset ──────────────────────────────────────
function resetSimulation() {
  // Stop any running timer
  senderTimer.stop();
  senderTimer.reset();

  // Reset protocol state
  sendBase = 0;
  nextSeq = 0;
  rcvExpect = 0;
  forceLossNext = false;
  isRetransmitting = false;

  btnLose.disabled = false;
  btnLose.classList.remove("reset");
  btnLose.textContent = "Simulate Loss on Next Dispatch";

  // Clear all flying packets from channel
  channelArea.querySelectorAll(".flying-packet").forEach((p) => p.remove());

  // Rebuild sender and receiver grid cells
  senderCells.forEach((c) => c.remove());
  receiverCells.forEach((c) => c.remove());
  senderCells.length = 0;
  receiverCells.length = 0;

  for (let i = 0; i < TOTAL_PACKETS; i++) {
    const seqLabel = i % MAX_SEQ_NUM;

    const sc = document.createElement("div");
    sc.className = "array-cell";
    sc.setAttribute("data-index", i);
    sc.textContent = `Seq ${seqLabel}`;
    senderContainer.appendChild(sc);
    senderCells.push(sc);

    const rc = document.createElement("div");
    rc.className = "array-cell";
    rc.setAttribute("data-index", i);
    rc.textContent = `-`;
    receiverContainer.appendChild(rc);
    receiverCells.push(rc);
  }

  setTimeout(() => updateSlidingWindows(), 50);
  log(
    `Simulation reset. Window size = ${WINDOW_SIZE}. Seq space = ${MAX_SEQ_NUM} [0–${MAX_SEQ_NUM - 1}].`,
    "success",
  );
}

// ── Initial render configuration call ───────────────────────
setTimeout(() => updateSlidingWindows(), 150);
log(
  `System initialized with Sequence Size space = ${MAX_SEQ_NUM} [0-${MAX_SEQ_NUM - 1}].`,
  "success",
);
