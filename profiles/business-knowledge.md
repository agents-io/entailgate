# Business knowledge profile

Load this profile for customer-service, missed-call, booking, sales, or operations agents that must stay within information supplied by the business owner.

## Source boundary

The Source Box may contain service descriptions, prices, locations, hours, availability rules, refund or cancellation terms, scripts, FAQs, and escalation policies. Model memory, common industry practice, and another customer’s conversation are not business facts.

Enumerate each input inside the run Source Box under the correct role:

- `OWNER_KNOWLEDGE`: stable business facts and policies supplied by the owner;
- `CUSTOMER_INPUT`: what the customer said, supplied, or requested;
- `LIVE_STATE`: an authorized current lookup, including its timestamp;
- `EXECUTION_RECEIPT`: a readable receipt for an exact completed action.

Each role may support only its permitted claim class. `CUSTOMER_INPUT` cannot support business facts, live state, authorization, or completed actions. `OWNER_KNOWLEDGE` cannot prove current availability unless the enumerated source is itself the authorized live state. Inclusion in the Source Box does not make an input authoritative for every proposition.

Do not turn missing business information into a confident answer. Ask the narrow question authorized by Policy or escalate.

## Verification priorities

Check every material answer for:

- correct service, price, unit, tax, fee, and qualification;
- correct location, time zone, opening hours, and date;
- eligibility, availability, capacity, and required prerequisites;
- cancellation, refund, deposit, warranty, and exception language;
- promises, commitments, or guarantees not made by the owner;
- whether a live-state claim was actually obtained from an authorized current source;
- whether the answer implies an action already happened when it was only proposed.

## Actions remain separate

A supported answer does not authorize booking, cancelling, charging, messaging, or changing records. Before any action, the agent must have the required customer details, current availability, owner policy, and the authorization required by the surrounding product workflow.

A claim that an action already occurred, such as `I booked it`, requires an authorized workflow receipt identifying that exact action. A customer request is neither authorization nor an execution receipt.

A claimed completed action without an enumerated receipt is `OUTSIDE_SOURCE`. If an enumerated receipt cannot be read or authenticated, it is `SOURCE_UNAVAILABLE`. Either verdict blocks release of the Subject as written. The report’s `Action state` field is not evidence.

Entailgate may verify that the proposed action and its stated basis match the Source Box. It does not execute or authorize the action.
