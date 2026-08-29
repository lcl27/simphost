# Data licensing

This is the constraint the brief identifies as binding, and the one part of this
project that cannot be left to run itself. Read this before adding a data source.

## What this service uses

**Companies House public data API** (`api.company-information.service.gov.uk`)
and nothing else. Companies House content is Crown copyright, published under the
[Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/),
which permits commercial re-use with attribution. Every tool response carries a
`source` block naming Companies House and reproducing the OGL attribution.

The service is a **live pass-through**. It holds no Companies House data beyond a
five-minute edge cache (`src/companies-house/client.ts`), which exists to stay
inside the API's rate limit rather than to build a corpus. Nothing is
accumulated, and there is no bulk copy of the register to redistribute.

## What this service deliberately does not use

The brief is explicit and it is right:

- **RNS announcement content** is licensed by LSEG. Not used.
- **The AIM Rules** are London Stock Exchange copyright. Not used, not quoted,
  not summarised.
- **Anything else behind a licence.** Given the day job, an intellectual-property
  misstep here costs more than this endpoint could plausibly earn.

## The Companies House enumeration files

Companies House publishes `companieshouse/api-enumerations` on GitHub — the
files that turn a terse `description` code such as `capital-allotment-shares`
into rendered English. They are the obvious way to make filing history readable.

**They are not used here.** That repository carries no `LICENSE` file and no
stated licence terms. The OGL covers Companies House *content*; whether it covers
this particular repository's prose is a question nobody has answered in writing,
and the cost of getting it wrong exceeds the cost of not needing it.

Instead, `src/companies-house/taxonomy.ts` and
`src/companies-house/psc-taxonomy.ts` contain an original classification written
for this service:

- Filing codes are matched by rule to one of thirteen groups and a significance
  rating, with labels written here rather than borrowed.
- Natures of control are **decomposed structurally** — every Companies House PSC
  code is systematically constructed, so `voting-rights-50-to-75-percent-as-trust`
  parses to `{ right: "voting-rights", band: "50-75", held_via: "trust" }`
  without needing anyone's prose.

This turned out better than the lookup would have been: a caller can filter on
"more than 25% of voting rights, however held" without pattern-matching English.
But the reason it exists is the licence question, not the design.

If someone with the standing to do so establishes that the enumerations are
OGL-covered, importing them would add rendered descriptions cheaply. That is a
decision to take deliberately, not to drift into.

## Personal data

PSC records contain personal data: names, nationality, country of residence,
month and year of birth. UK GDPR applies to processing it, including onward
processing by this service.

What the code does about that:

- No PSC personal data is written to the usage ledger. The ledger records the
  **company number** asked about, never a person's name. See
  `src/metering/ledger.ts`.
- No PSC data is persisted beyond the five-minute edge cache.
- Super-secure records are reported as `protected`, never resolved further.
- Verification status that cannot be established is reported as `not_reported`,
  never as `unverified`. A compliance caller that reads absence of data as
  evidence of non-compliance will be wrong about a real person.

## Open items — these need a human

1. **Companies House API terms of use.** Distinct from the OGL content licence.
   Review the current terms for conditions on caching, on re-supply to third
   parties, and on attribution wording, before this endpoint carries meaningful
   volume. The five-minute cache and the per-response attribution are written to
   be defensible, but they were written without legal advice.
2. **Commercial resale of derived data.** The OGL permits commercial re-use. The
   API terms are the narrower constraint. Confirm before any flat-rate tier is
   offered to a compliance vendor, and before any trade sale of the assembled
   dataset.
3. **FCA National Storage Mechanism** — the first-month step in the brief. The
   NSM hosts documents whose copyright sits with the issuers, not the FCA.
   Structured *metadata about* announcements (issuer, date, category, headline,
   document reference) is a materially different proposition from republishing
   the documents. Take advice before month two. Do not assume the answer.
4. **Regulatory position of the day job.** An endpoint that sells UK corporate
   data commercially may engage internal conflicts, outside-business-interest or
   personal-account-dealing policies regardless of what the data licence says.
   That is a compliance question, not a legal one, and it should be settled
   before the wallet address goes live.
