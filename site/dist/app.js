const knowledge = [
  {
    terms: ["what", "factlock", "product", "does"],
    answer: "FactLock is a verification layer for business facts. It turns checked claims—such as identity, licenses, hours, prices, and availability—into signed records that software agents can verify before they act."
  },
  {
    terms: ["bbb", "better", "business", "bureau", "review", "reviews", "reputation", "site"],
    answer: "The analogy is useful, but FactLock is not a review site. A BBB-style organization helps people assess businesses; FactLock gives software a machine-readable verdict about a specific claim, its evidence, and when that proof expires."
  },
  {
    terms: ["who", "verify", "verifies", "verifier", "claim", "evidence"],
    answer: "A claim can be checked through authoritative registries, reviewed documents, controlled APIs, or a field verifier. FactLock only signs after server-held evidence covers the exact claim and the business authorization is bound to the authenticated owner."
  },
  {
    terms: ["agent", "agents", "api", "mcp", "integration", "integrate", "use", "check"],
    answer: "An agent calls FactLock with an attestation ID or business ID. The API and MCP tool verify signatures, transparency-log inclusion, lifecycle status, and freshness, then return a compact verdict before the agent quotes, books, or pays."
  },
  {
    terms: ["fresh", "freshness", "expire", "expires", "current", "stale", "recheck"],
    answer: "Every claim has a re-verification interval. A record is VERIFIED while current, RECHECK when it approaches expiry, and untrusted at the exact expiration boundary. Different facts age at different speeds; availability expires faster than identity."
  },
  {
    terms: ["wrong", "dispute", "disputed", "correction", "corrected", "appeal"],
    answer: "A disputed record immediately becomes untrusted. If it is corrected, the old record remains visible for auditability but is marked superseded and cannot be used as valid proof; agents must verify the replacement."
  },
  {
    terms: ["private", "privacy", "price", "hidden", "secret", "confidential"],
    answer: "Public responses redact undisclosed price amounts. The next protocol design should go further: publish salted commitments instead of raw private values, keep evidence encrypted, and disclose the value only to an authorized verifier."
  },
  {
    terms: ["blockchain", "chain", "merkle", "transparency", "tamper"],
    answer: "FactLock uses signatures and a Merkle transparency log so silent changes are detectable. Periodic anchoring can establish that a log root existed at a given time; verification does not require a blockchain transaction for every claim."
  },
  {
    terms: ["business", "benefit", "owner", "why", "value"],
    answer: "A business gets a portable proof that agents can trust without scraping a website or guessing from reviews. That can reduce bad quotes, failed bookings, payment disputes, and repeated requests for the same documents."
  },
  {
    terms: ["consumer", "customer", "people", "human"],
    answer: "FactLock is designed for machine decisions first, but the proof can also appear as a public badge or verification page. People see the same status, evidence boundaries, freshness, and dispute state that an agent receives."
  },
  {
    terms: ["muse", "meta"],
    answer: "FactLock is being designed as an independent API and MCP trust layer. A Muse integration is a natural adapter once its third-party interface and production requirements are stable; the core verification model does not depend on one agent platform."
  },
  {
    terms: ["price", "pricing", "cost", "pilot", "join", "access"],
    answer: "Commercial pricing is not published yet. The sensible first phase is a narrow pilot with agent builders and high-intent local-service businesses, measuring verification coverage, check volume, and prevented errors before setting plans."
  },
  {
    terms: ["guarantee", "trust", "safe", "truth", "accurate"],
    answer: "FactLock proves that a defined check passed for a specific claim at a specific time. It does not guarantee future performance. That distinction—proof scope, timestamp, and expiry—is the foundation of the trust model."
  }
];

const stopWords = new Set(["a", "an", "and", "are", "can", "do", "does", "for", "how", "i", "in", "is", "it", "of", "on", "the", "to", "with"]);
const stream = document.querySelector("#answer-stream");
const form = document.querySelector("#question-form");
const input = document.querySelector("#question-input");

function tokens(value) {
  return value.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((word) => word && !stopWords.has(word));
}

function answerFor(question) {
  const words = tokens(question);
  let best = null;
  let bestScore = 0;
  for (const item of knowledge) {
    const score = item.terms.reduce((sum, term) => sum + (words.some((word) => word === term || word.startsWith(term) || term.startsWith(word)) ? 1 : 0), 0);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  if (best && bestScore >= 1) return best.answer;
  return "I don’t have a reliable answer for that yet—and FactLock should not invent one. Try asking about evidence, disputes, freshness, privacy, pricing, Muse, the API, or how an agent checks a claim.";
}

function appendMessage(className, label, text) {
  const item = document.createElement("div");
  item.className = className;
  if (label) {
    const tag = document.createElement("span");
    tag.className = "answer-label";
    tag.textContent = label;
    item.appendChild(tag);
  }
  const body = document.createElement("p");
  body.textContent = text;
  item.appendChild(body);
  stream.appendChild(item);
  stream.scrollTop = stream.scrollHeight;
}

function ask(question) {
  const clean = question.trim();
  if (!clean) return;
  appendMessage("question", "", clean);
  appendMessage("answer", "FACTLOCK", answerFor(clean));
  input.value = "";
  input.style.height = "auto";
  input.focus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  ask(input.value);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
});

document.querySelectorAll(".question-prompts button").forEach((button) => {
  button.addEventListener("click", () => ask(button.textContent));
});
