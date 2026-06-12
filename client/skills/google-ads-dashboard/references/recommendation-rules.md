# Recommendation Rules

## Rule 1: Pause Keyword Candidate

**Type:** `PAUSE_KEYWORD_CANDIDATE`

**Trigger conditions (ALL must be true):**
- `cost > category_target_CPA × 1.5`
- `0 Primary Conversions (Book Appointment, Trial Signup)`
- `clicks >= 3`
- Keyword is not brand-critical (not the advertiser's own brand name)

**Priority:** HIGH if `cost > category_target_CPA × 3`, else MEDIUM

**Risk:** LOW (pausing a zero-conversion keyword is generally safe)

---

## Rule 2: Negative Keyword Candidate

**Type:** `ADD_NEGATIVE_KEYWORD_CANDIDATE`

**Trigger conditions (ANY set):**

**Set A — high-spend zero-conversion search term:**
- `cost > 0` AND `0 Primary Conversions (Book Appointment, Trial Signup)` AND `clicks >= 2`

**Set B — low-intent language:**
- Search term contains any of: `free`, `job`, `login`, `support`, `tutorial`,
  `template`, `meaning`, `how to`, `download`, `salary`, `career`, `internship`
- AND `0 Primary Conversions (Book Appointment, Trial Signup)`

**Set C — competitor navigational queries:**
- Search term is a direct competitor brand name (`aisensy`, `wati`, `interakt`,
  `doubletick`, `gallabox`) AND the matched keyword is also that brand
- AND `CPA > category_target_CPA × 2` OR `0 Primary Conversions (Book Appointment, Trial Signup)`

**Priority:** HIGH if cost > ₹500, MEDIUM if cost > ₹100, LOW otherwise

**Risk:** MEDIUM (always needs human review to confirm intent classification)

---

## Rule 3: Scale Keyword Candidate

**Type:** `SCALE_KEYWORD_CANDIDATE`

**Trigger conditions (ALL must be true):**
- `>= 1 Primary Conversion (Book Appointment, Trial Signup)`
- `CPA < category_target_CPA`
- `CVR > category average CVR`
- Impression share data suggests room to grow (IS < 80% or budget lost IS > 10%)

**Priority:** HIGH if `CPA < category_target_CPA × 0.5`, else MEDIUM

**Risk:** LOW

---

## Rule 4: Promote Search Term to Keyword

**Type:** `PROMOTE_SEARCH_TERM_TO_KEYWORD`

**Trigger conditions (ALL must be true):**
- Search term has `>= 1 Primary Conversion (Book Appointment, Trial Signup)`
- `CPA <= category_target_CPA`
- Search term is not already an exact-match keyword
- `clicks >= 3`

**Priority:** MEDIUM

**Risk:** LOW

---

## Rule 5: Landing Page Issue

**Type:** `LANDING_PAGE_ISSUE`

**Trigger conditions (ANY):**
- Two URLs with similar traffic but CVR differs by > 3×
- A URL with `clicks >= 10` AND `0 Primary Conversions (Book Appointment, Trial Signup)`
- URL inconsistency (e.g., trailing slash vs no trailing slash, both receiving spend)

**Priority:** HIGH (tracking / conversion leaks are costly)

**Risk:** MEDIUM

---

## Rule 6: Competitor Campaign Review

**Type:** `COMPETITOR_CAMPAIGN_REVIEW`

**Trigger conditions:**
- Competitor conquesting keywords collectively have:
  - `spend_share > 50%` of account total
  - `CPA > category_target_CPA × 2`

**Priority:** HIGH

**Risk:** HIGH (reducing competitor spend is a strategic decision)

---

## Rule 7: Budget Review

**Type:** `BUDGET_SCALE_CANDIDATE`

**Trigger conditions:**
- `search_budget_lost_impression_share > 30%`
- Campaign has `>= 1 Primary Conversion (Book Appointment, Trial Signup)` AND `CPA <= category_target_CPA × 1.2`

**Priority:** MEDIUM

**Risk:** MEDIUM

---

## Rule 8: Bid Strategy Review

**Type:** `BID_STRATEGY_REVIEW`

**Trigger conditions:**
- Campaign using Maximize Conversions without a target CPA
- AND `CPA > category_target_CPA × 1.5`

**Priority:** MEDIUM

**Risk:** LOW

---

## Confidence Gating

- If a keyword/search term has `clicks < 3` AND `cost < ₹100`, mark proposal
  as `NEEDS_MORE_DATA` instead of `PENDING_REVIEW`.
- Require at least a 14-day lookback window for identifying "Wasted Spend" or pause candidates to account for B2B SaaS sales cycles. If data covers < 14 days, mark proposal as `WATCHLIST` instead of `PENDING_REVIEW`.