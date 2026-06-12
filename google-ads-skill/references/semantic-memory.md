# Semantic Memory

Use semantic memory for fuzzy human context that should influence future analysis but is not a metric: client preferences, business constraints, exceptions, proposal postmortems, risks, and account notes.

Do not store structured dashboard metrics, proposal statuses, impact labels, strategy priors, or anything already represented in SQL. The backend only validates, stores, searches, and links rows. The external agent must extract memories, generate embeddings, compare semantic duplicates, and decide whether a note is new, duplicate, refinement, supersession, or exception.

## Tools

- `create_memory`: create an active memory row.
- `store_memory_embedding`: store the externally generated 1536-dimension embedding for a memory.
- `search_memories`: run one tenant-scoped vector search over active memories for a batched scope set.
- `deactivate_memory`: deactivate stale or superseded memories and delete embeddings in the same transaction.
- `link_memory_exception`: link a narrower active memory as an exception to a broader active memory.

## Required Creation Fields

`create_memory` requires:

- `customer_id`
- `scope_type`
- `category`
- `content`
- `verification_status`
- `authority`
- `source`

Optional relationship fields:

- `supersedes_memory_id`: use when the new memory replaces an active older memory.
- `exception_to_memory_id`: use when the new memory is a narrower exception to a broader memory.
- `related_proposal_id`: use for postmortems or context tied to a proposal but scoped elsewhere.
- `valid_until`: use for temporary constraints.

After `create_memory`, call `store_memory_embedding` with `customer_id`, `memory_id`, `embedding_model`, `dimensions: 1536`, and the externally generated embedding.

## Enums

`scope_type`: `global`, `campaign`, `ad_group`, `keyword`, `search_term`, `proposal`, `account_note`

`category`: `preference`, `constraint`, `exception`, `postmortem`, `business_context`, `risk`

`verification_status`: `user_confirmed`, `agent_extracted`, `inferred_from_postmortem`, `imported`

`authority`: `hard_constraint`, `soft_preference`, `observation`

`source`: `user_chat`, `proposal_feedback`, `proposal_postmortem`, `manual_note`, `imported_doc`

## Scope Rules

Always include `customer_id` and the narrowest reliable Google Ads resource-name scope.

- `global` or `account_note`: customer-level memory. `customer_resource_name` defaults to `customers/<customer_id>`.
- `campaign`: requires `campaign_resource_name` or `campaign_id`.
- `ad_group`: requires `ad_group_resource_name` or `ad_group_id`.
- `keyword`: requires `criterion_resource_name` or `ad_group_id` plus `criterion_id`.
- `search_term`: requires `search_term`.
- `proposal`: requires `proposal_id`.

Use raw IDs only as helpers when resource names are not already available; the backend derives resource names where possible and rejects mismatched IDs.

For `search_term` scope, send the original `search_term`. The backend stores that raw value and derives `search_term_normalized` deterministically by tokenizing alphanumeric words, lowercasing, stemming, sorting tokens, and joining them with spaces. Search calls should usually send raw `search_terms`; only send `search_terms_normalized` when you intentionally mirror that backend normalization.

Postmortem lessons should normally be scoped to the affected account, campaign, ad group, keyword, or search term. Use `related_proposal_id` to preserve the proposal link. Use `scope_type = "proposal"` only for notes about the proposal artifact itself.

Proposal feedback is raw SQL context until reviewed. Convert it to semantic memory only when the comment is durable. Use `source = "proposal_feedback"` and `source_ref = "proposal_feedback:<feedback_id>"`, then mark the feedback `converted_to_memory` through `update_proposal_feedback_status` after the embedding is stored.

## Search Rules

Before creating proposals, call `search_memories` when campaign, ad-group, keyword, search-term, proposal, or account-level human context could matter.

Search once with a batched scope list, not once per entity. Include every reliable scope from the current task:

- `customer_resource_names`
- `campaign_resource_names`
- `ad_group_resource_names`
- `criterion_resource_names`
- `proposal_ids`
- `search_terms`
- `search_terms_normalized`

Entity scope arrays match the same declared memory scope type. A campaign scope search returns campaign memories; it does not automatically return keyword or search-term memories that happen to carry the same campaign resource. Include the lower-level ad group, criterion, and search-term scopes whenever lower-level memories could change the answer.

Search-term memory retrieval matches exact normalized terms and also uses pg_trgm similarity against normalized search terms. Treat fuzzy search-term matches as context that needs verification, not as proof that the exact query was previously reviewed.

`proposal_ids` searches both proposal-scoped memories and `related_proposal_id`, so entity-scoped postmortems tied to older proposals can still be retrieved.

Use the same external embedding model and `dimensions: 1536` used for stored memory embeddings. Treat returned memories as context, not proof. If memory changes proposal framing, ranking, or risk, add proposal or option `memory_context` with:

- `summary`: plain-English explanation of how memory affected the recommendation,
- `memories`: the specific memory rows used, including `memory_id`, `category`, `scope_type`, `authority`, `verification_status`, `content`, `reason`, and `influence` when available,
- `caveats`: stale, weak, temporary, or user-confirmation concerns.

Still cite current metrics. Do not use memory as a substitute for evidence.

## Relationship Rules

Use `link_memory_exception` or `exception_to_memory_id` only when the exception is equal to or narrower than the general memory scope and parent identifiers match.

Use `deactivate_memory` for superseded, stale, or invalid memories. If a replacement exists, pass `replacement_memory_id` only when the replacement memory has `supersedes_memory_id` pointing to the deactivated memory. Deactivating a memory also deactivates active exception descendants.
