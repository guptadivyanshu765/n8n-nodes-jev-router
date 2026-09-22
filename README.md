# n8n-nodes-jev-router

An [n8n](https://n8n.io) community node integrating [TypeSafe AI](https://typesafe.ai)'s
**Jev** model — a "System One" decision model, not a chat model. You send it one or more typed
questions (Choice, Score, or Noul/Boolean) about a piece of text or data, and it answers each
with a structured, typed value plus a confidence or probability score, in a single API call.

This package integrates exactly one third-party service — TypeSafe AI's `/v1/systemone`
endpoint — through one node with two operations: **Classify & Route**, which calls Jev and
optionally branches the workflow by one of its answers, and **Calibration Check**, which
validates Jev's confidence scores against your own labeled data. The branching in Classify &
Route is a UX layer built directly on top of that API call (similar to how many integration
nodes expose a success/error output), not a standalone flow-control utility.

## What this node does

- **Classify & Route** — send an item's text/data to Jev along with one or more questions,
  answered in a single API call. Optionally pick one Choice question as the "routing question":
  the node then creates one output branch per possible answer (like the built-in Switch node),
  plus a **Needs Review** branch that catches anything below that question's confidence
  threshold. Every branch still gets all answers attached to the item, so you can reference
  a Score or Noul answer downstream even if it wasn't the one used for routing.
- **Calibration Check** — before you trust Jev's confidence scores in production, run this
  mode against your own labeled historical data. It compares Jev's prediction to a ground-truth
  field on each item, buckets the results by confidence range, and reports accuracy per bucket
  — so you can pick a real threshold (e.g. "above 0.85 confidence, Jev was right 96% of the
  time") instead of guessing 0.5 and hoping.

The node is also flagged `usableAsTool`, so it can be added directly to an n8n **AI Agent**
node's tool list and called by an agent.

## Install

In n8n: **Settings → Community Nodes → Install**, and enter:

```
n8n-nodes-jev-router
```

For local development against a self-hosted n8n instance, set `N8N_CUSTOM_EXTENSIONS` to this
project's `dist/` directory (after `npm install && npm run build`) so n8n picks it up without
needing the package published first — see
[n8n's community node development docs](https://docs.n8n.io/integrations/creating-nodes/) for
details.

## Credentials

Create a **Jev API** credential with:

- **API Key** — your TypeSafe AI API key, sent as `Authorization: Bearer <key>`.
- **Base URL** — defaults to `https://api.typesafe.ai`. Override this to point at OpenRouter
  or another Jev-compatible gateway.

## Example: routing support tickets

A common use case is triaging inbound support tickets without an LLM chat round-trip.

**Operation:** Classify & Route
**State:** `{{$json.ticketBody}}`

**Questions:**

| Question ID | Type   | Instructions                                            | Criteria / Options |
|-------------|--------|----------------------------------------------------------|---------------------|
| `department` | Choice | Which department should handle this ticket?             | `billing`, `sales`, `technical` |
| `urgency`    | Score  | How urgent is this ticket?                               | Low, Medium, High, Critical |
| `refund_requested` | Noul | Is the customer explicitly asking for a refund?     | — |

**Routing Question:** `department`, with a confidence threshold of `0.75`.

A ready-to-import version of this exact workflow (Manual Trigger → sample ticket → Jev Router
→ one Set node per branch, so you can see what lands where) is in
[`examples/support-ticket-routing.json`](examples/support-ticket-routing.json). In n8n, go to
**Workflows → Import from File** and select it — you'll just need to pick your own `Jev API`
credential on the Jev Router node before running it.

This produces four outputs: **billing**, **sales**, **technical**, and **Needs Review**. A
ticket Jev is confident is billing-related routes straight to the `billing` branch; anything
under 0.75 confidence — regardless of which department it guessed — lands in **Needs Review**
for a human to triage. Every branch also carries `urgency_score` and `refund_requested_noul`
on the item, so a downstream node can, say, page someone when `urgency_score` is high even on
a ticket that got auto-routed to `sales`.

## Example: checking calibration before you trust it

Before wiring the routing threshold above into production, run the same questions in
**Calibration Check** mode against a set of tickets you've already labeled by hand:

**Operation:** Calibration Check
**State Field Name:** `ticketBody`
**Ground Truth Field Name:** `actual_department`
**Questions:** same `department` question as above
**Question to Compare:** `department`

The output is a single item summarizing accuracy per confidence bucket (0.9–1.0, 0.8–0.9, …),
so you can see exactly where Jev's confidence stops being trustworthy on *your* data before
picking a threshold — rather than assuming the model's stated confidence is well-calibrated
out of the box.

## Notes

- Questions are always batched into a single Jev API call per item (never one call per
  question).
- Transient errors (HTTP 429 rate-limited, 529 overloaded) are retried automatically with
  exponential backoff, up to 4 attempts — no node setting to enable.
- Noul questions have no confidence field in Jev's response (only a probability), so the
  Confidence Threshold field is hidden for them in the UI; threshold on the noul probability
  value itself instead.

## License

MIT
