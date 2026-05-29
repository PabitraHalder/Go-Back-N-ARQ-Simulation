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
    this._tick();
  }
  _tick() {
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
    if (this.displayEl) this.displayEl.textContent = `${s}s`;
    const pct = (this.remainingTime / this.duration) * 100;
    if (this.progressBarEl) this.progressBarEl.style.width = `${pct}%`;
  }
}

// ── Configuration ────────────────────────────────────────────
let WINDOW_SIZE = 3;
let MAX_SEQ_NUM = WINDOW_SIZE + 1; // GBN constraint: seqSpace = windowSize + 1
const TOTAL_PACKETS = 8;
let FLIGHT_DURATION = 1200;

// ── Protocol State ───────────────────────────────────────────
let sendBase = 0; // oldest unACKed packet index
let nextSeq = 0; // next packet index to send (raw, 0..TOTAL_PACKETS)
let rcvExpect = 0; // receiver's expected raw index
let forceLossNext = false;
let forceAckLossNext = false;
let isRetransmitting = false;

// ── DOM ──────────────────────────────────────────────────────
const senderContainer = document.querySelector(".sender");
const receiverContainer = document.querySelector(".receiver");
const channelArea = document.getElementById("channelArea");
const logBody = document.getElementById("logBody");

const elSendBase = document.getElementById("sendBase");
const elNextSeq = document.getElementById("nextSeq");
const elRcvExpected = document.getElementById("rcvExpected");

const btnSend = document.querySelector(".send-pkt-btn");
const btnLose = document.querySelector(".lose-pkt-btn");
const btnLoseAck = document.querySelector(".lose-ack-btn");
const btnReset = document.querySelector(".reset");

// Sliding window overlay boxes
const senderWinBox = document.createElement("div");
senderWinBox.className = "sliding-window sender-window";
senderContainer.appendChild(senderWinBox);

const receiverWinBox = document.createElement("div");
receiverWinBox.className = "sliding-window receiver-window";
receiverContainer.appendChild(receiverWinBox);

const senderCells = [];
const receiverCells = [];

// ── Grid Initialisation ───────────────────────────────────────
function buildGrid() {
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
}
buildGrid();

// ── Timer ────────────────────────────────────────────────────
// Timer fires only for the oldest unACKed frame (sendBase).
// On timeout → retransmit everything from sendBase..nextSeq-1.
const senderTimer = new ARQTimer(10, "timerDisplay", "progressBar", () => {
  const baseHeaderSeq = sendBase % MAX_SEQ_NUM;
  log(
    `TIMEOUT! Frame Seq ${baseHeaderSeq} (index ${sendBase}) expired. Initiating GBN rollback.`,
    "timeout",
  );
  handleGoBackNRetransmission();
});

// ── Sliding Window UI ─────────────────────────────────────────
function updateSlidingWindows() {
  // Sender window spans [sendBase .. sendBase+WINDOW_SIZE-1]
  if (sendBase < TOTAL_PACKETS) {
    const spanEnd = Math.min(sendBase + WINDOW_SIZE - 1, TOTAL_PACKETS - 1);
    const topCell = senderCells[sendBase];
    const botCell = senderCells[spanEnd];
    const topOff = topCell.offsetTop;
    const botOff = botCell.offsetTop + botCell.offsetHeight;
    senderWinBox.style.top = `${topOff - 4}px`;
    senderWinBox.style.height = `${botOff - topOff + 8}px`;
    senderWinBox.style.display = "block";
  } else {
    senderWinBox.style.display = "none";
  }

  // Receiver window is always a single-cell window at rcvExpect
  if (rcvExpect < TOTAL_PACKETS) {
    const rcvCell = receiverCells[rcvExpect];
    receiverWinBox.style.top = `${rcvCell.offsetTop - 4}px`;
    receiverWinBox.style.height = `${rcvCell.offsetHeight + 8}px`;
    receiverWinBox.style.display = "block";
    receiverCells.forEach((c, idx) => {
      c.classList.toggle("expected", idx === rcvExpect);
    });
  } else {
    receiverWinBox.style.display = "none";
    receiverCells.forEach((c) => c.classList.remove("expected"));
  }

  // Update stat displays (show header seq values, not raw indices)
  elSendBase.textContent = sendBase % MAX_SEQ_NUM;
  elNextSeq.textContent = nextSeq % MAX_SEQ_NUM;
  elRcvExpected.textContent = rcvExpect % MAX_SEQ_NUM;

  // Send button is disabled when window is full, all packets sent, or mid-retransmit
  btnSend.disabled =
    nextSeq >= sendBase + WINDOW_SIZE ||
    nextSeq >= TOTAL_PACKETS ||
    isRetransmitting;
}

// ── Logging ───────────────────────────────────────────────────
function log(msg, type = "info") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logBody.prepend(entry);
}

// ── Animation Helpers ─────────────────────────────────────────
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

    void pkt.offsetWidth; // force reflow

    pkt.style.transition = `left ${FLIGHT_DURATION}ms linear, opacity 300ms ease`;

    if (isLost) {
      // Travel to midpoint then fade out
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

// ── Core: Send a Single Packet ────────────────────────────────
// FIXED:
//  • nextSeq only incremented when sending a genuinely new frame (not during retransmit)
//  • cumulative ACK matching uses a clear loop over [sendBase..nextSeq)
//  • timer only restarted when sendBase actually advances
//  • duplicate frame (scenario B) always re-ACKs without touching nextSeq/rcvExpect
async function sendPacket(packetIndex, isRetransmit = false) {
  if (packetIndex >= TOTAL_PACKETS) return;

  const headerSeqNo = packetIndex % MAX_SEQ_NUM;

  // ── Consume loss flags (only on the first packet sent, not re-acks) ──
  const currentLossTarget = !isRetransmit && forceLossNext;
  if (currentLossTarget) {
    forceLossNext = false;
    btnLose.classList.remove("reset");
    btnLose.textContent = "Simulate Loss on Next Dispatch";
  }

  const currentAckLossTarget = !isRetransmit && forceAckLossNext;
  if (currentAckLossTarget) {
    forceAckLossNext = false;
    btnLoseAck.classList.remove("reset");
    btnLoseAck.textContent = "Simulate ACK Loss on Next Dispatch";
  }

  log(
    `[Tx] ${isRetransmit ? "Re-sending" : "Sending"} packet index ${packetIndex} → Header Seq ${headerSeqNo}`,
    "info",
  );
  senderCells[packetIndex].className = "array-cell sent";

  // Start the timer when we send the base frame (oldest unACKed)
  if (packetIndex === sendBase && !senderTimer.timerId) {
    senderTimer.start();
  }

  // Only advance nextSeq for genuinely new transmissions
  if (!isRetransmit && packetIndex === nextSeq) {
    nextSeq++;
  }
  updateSlidingWindows();

  // ── Forward channel ──
  const result = await animateFlight(
    `Seq ${headerSeqNo}`,
    false,
    getRowY(packetIndex),
    currentLossTarget,
  );

  if (!result.delivered) {
    log(
      `[Loss] Forward packet Seq ${headerSeqNo} dropped in channel.`,
      "error",
    );
    return;
  }

  // ── Receiver logic ──
  const expectedHeaderSeq = rcvExpect % MAX_SEQ_NUM;

  if (headerSeqNo === expectedHeaderSeq && packetIndex === rcvExpect) {
    // ── SCENARIO A: Expected in-order frame ──
    log(
      `[Rx] In-order! Seq ${headerSeqNo} accepted. (index ${packetIndex})`,
      "success",
    );
    receiverCells[rcvExpect].className = "array-cell received";
    receiverCells[rcvExpect].textContent = `Seq ${headerSeqNo} ✓`;
    rcvExpect++;
    updateSlidingWindows();

    const ackVal = rcvExpect % MAX_SEQ_NUM;
    log(`[Rx] Sending cumulative ACK ${ackVal}`, "info");

    const ackResult = await animateFlight(
      `ACK ${ackVal}`,
      true,
      getRowY(packetIndex),
      currentAckLossTarget,
    );

    if (ackResult.delivered) {
      processAck(rcvExpect); // pass raw expected index so matching is unambiguous
    } else {
      log(`[Loss] ACK ${ackVal} dropped in channel!`, "error");
      // GBN: sender will timeout and retransmit — no action needed at receiver
    }
  } else if (packetIndex < rcvExpect) {
    // ── SCENARIO B: Duplicate (already received, ACK was lost) ──
    log(
      `[Rx] Duplicate frame Seq ${headerSeqNo} (index ${packetIndex}). Discarding data, re-ACKing.`,
      "timeout",
    );

    const ackVal = rcvExpect % MAX_SEQ_NUM;
    log(`[Rx] Re-sending cumulative ACK ${ackVal}`, "info");

    const ackResult = await animateFlight(
      `ACK ${ackVal}`,
      true,
      getRowY(packetIndex),
      false, // re-ACKs never get dropped
    );

    if (ackResult.delivered) {
      processAck(rcvExpect);
    }
  } else {
    // ── SCENARIO C: Out-of-order frame (GBN: discard, NAK with current ACK) ──
    log(
      `[Rx] Out-of-order! Got Seq ${headerSeqNo} but expected Seq ${expectedHeaderSeq}. Discarding.`,
      "error",
    );
    const ackVal = rcvExpect % MAX_SEQ_NUM;
    log(`[Rx] Re-sending current ACK ${ackVal}`, "info");
    await animateFlight(`ACK ${ackVal}`, true, getRowY(packetIndex), false);
    // Sender ignores duplicate/old ACKs — only a timeout triggers GBN rollback
  }
}

// ── Cumulative ACK Processing ─────────────────────────────────
// FIXED: accepts rawExpect (the raw rcvExpect value) instead of a header seq number,
//        so mapping from ACK value → sendBase advance is exact and unambiguous.
//
// rawExpect = rcvExpect at the moment the receiver sent the ACK.
// All indices in [sendBase .. rawExpect-1] are now cumulatively acknowledged.
function processAck(rawExpect) {
  if (rawExpect <= sendBase) return; // stale or duplicate ACK — ignore

  const headerAck = rawExpect % MAX_SEQ_NUM;
  log(
    `[Tx] Cumulative ACK ${headerAck} received. Sliding window from index ${sendBase} → ${rawExpect}.`,
    "success",
  );

  for (let i = sendBase; i < rawExpect; i++) {
    senderCells[i].className = "array-cell acked";
  }
  sendBase = rawExpect;

  if (sendBase >= nextSeq) {
    // All outstanding frames acknowledged — stop timer
    senderTimer.stop();
    log("Pipeline clear. Timer stopped.", "success");
  } else {
    // Still have unACKed frames — restart timer for the new base
    senderTimer.start();
    log(
      `[Tx] Timer restarted for Seq ${sendBase % MAX_SEQ_NUM} (index ${sendBase}).`,
      "info",
    );
  }

  updateSlidingWindows();
  checkCompletion();
}

// ── Go-Back-N Retransmission ──────────────────────────────────
async function handleGoBackNRetransmission() {
  if (isRetransmitting) return; // guard against re-entrant timeout
  isRetransmitting = true;
  updateSlidingWindows(); // disables send button

  const retransmitFrom = sendBase;
  const retransmitTo = nextSeq; // exclusive upper bound — frozen here

  log(
    `[Retransmit] GBN rollback: re-sending indices ${retransmitFrom}..${retransmitTo - 1}`,
    "timeout",
  );

  // Reset cell style to "sent" (unsettled)
  for (let i = retransmitFrom; i < retransmitTo; i++) {
    senderCells[i].className = "array-cell sent";
  }

  // Stop the old timer; sendPacket will restart it when it sends the base frame
  senderTimer.stop();

  for (let i = retransmitFrom; i < retransmitTo; i++) {
    // If a previous frame in this loop already moved sendBase past i (via ACK),
    // skip frames that are already acknowledged
    if (i < sendBase) continue;
    await sendPacket(i, true /*isRetransmit*/);
  }

  isRetransmitting = false;
  updateSlidingWindows();
}

// ── Completion Check ──────────────────────────────────────────
function checkCompletion() {
  if (sendBase >= TOTAL_PACKETS) {
    log("✓ All packets transmitted and acknowledged successfully!", "success");
    senderTimer.stop();
    btnSend.disabled = true;
    btnLose.disabled = true;
    btnLoseAck.disabled = true;
  }
}

// ── Button: Send ──────────────────────────────────────────────
btnSend.addEventListener("click", () => {
  if (
    !isRetransmitting &&
    nextSeq < sendBase + WINDOW_SIZE &&
    nextSeq < TOTAL_PACKETS
  ) {
    sendPacket(nextSeq, false);
  }
});

// ── Button: Simulate packet loss ─────────────────────────────
btnLose.addEventListener("click", () => {
  forceLossNext = !forceLossNext;
  forceAckLossNext = false;
  btnLoseAck.classList.remove("reset");
  btnLoseAck.textContent = "Simulate ACK Loss on Next Dispatch";

  if (forceLossNext) {
    btnLose.classList.add("reset");
    btnLose.textContent = "Packet Loss Active";
    log("Next forward packet will be dropped.", "timeout");
  } else {
    btnLose.classList.remove("reset");
    btnLose.textContent = "Simulate PKT Loss on Next Dispatch";
  }
});

// ── Button: Simulate ACK loss ─────────────────────────────────
btnLoseAck.addEventListener("click", () => {
  forceAckLossNext = !forceAckLossNext;
  forceLossNext = false;
  btnLose.classList.remove("reset");
  btnLose.textContent = "Simulate PKT Loss on Next Dispatch";

  if (forceAckLossNext) {
    btnLoseAck.classList.add("reset");
    btnLoseAck.textContent = "ACK Loss Active";
    log("The ACK for the next packet will be dropped.", "timeout");
  } else {
    btnLoseAck.classList.remove("reset");
    btnLoseAck.textContent = "Simulate ACK Loss on Next Dispatch";
  }
});

// ── Button: Reset ─────────────────────────────────────────────
btnReset.addEventListener("click", () => resetSimulation());

// ── Speed Slider ──────────────────────────────────────────────
document.getElementById("speedSlider").addEventListener("input", (e) => {
  FLIGHT_DURATION = Number(e.target.value);
  document.getElementById("speedDisplay").textContent = `${FLIGHT_DURATION}ms`;
});

// ── Window Size Input ─────────────────────────────────────────
document.getElementById("windowSizeInput").addEventListener("change", (e) => {
  const val = Math.max(1, Math.min(7, Number(e.target.value))); // max 7: seqSpace=8 for 8 packets
  e.target.value = val;
  if (val === WINDOW_SIZE) return;

  WINDOW_SIZE = val;
  MAX_SEQ_NUM = WINDOW_SIZE + 1;
  document.getElementById("windowSize").textContent = WINDOW_SIZE;

  log(
    `Window size → ${WINDOW_SIZE}. Sequence space: 0–${MAX_SEQ_NUM - 1}. Resetting.`,
    "timeout",
  );
  resetSimulation();
});

// ── Full Reset ────────────────────────────────────────────────
function resetSimulation() {
  senderTimer.stop();
  senderTimer.reset();

  sendBase = 0;
  nextSeq = 0;
  rcvExpect = 0;
  forceLossNext = false;
  forceAckLossNext = false;
  isRetransmitting = false;

  btnSend.disabled = false;
  btnLose.disabled = false;
  btnLoseAck.disabled = false;
  btnLose.classList.remove("reset");
  btnLose.textContent = "Simulate PKT Loss on Next Dispatch";
  btnLoseAck.classList.remove("reset");
  btnLoseAck.textContent = "Simulate ACK Loss on Next Dispatch";

  // Clear in-flight animations
  channelArea.querySelectorAll(".flying-packet").forEach((p) => p.remove());

  // Rebuild grid cells
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
    `Reset. Window = ${WINDOW_SIZE}. Seq space = [0–${MAX_SEQ_NUM - 1}].`,
    "success",
  );
}

// ── Initial render ────────────────────────────────────────────
setTimeout(() => updateSlidingWindows(), 150);
log(
  `GBN ARQ initialised. Seq space = [0–${MAX_SEQ_NUM - 1}]. Window = ${WINDOW_SIZE}.`,
  "success",
);
