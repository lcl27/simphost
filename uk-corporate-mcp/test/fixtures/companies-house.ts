/**
 * Hand-built fixtures modelled on the shape of Companies House public data API
 * responses. They are not copies of any particular company's record: the field
 * names are the API's, the values are invented.
 */

export const filingHistoryFixture = {
  etag: "fixture",
  filing_history_status: "filing-history-available",
  items_per_page: 100,
  start_index: 0,
  total_count: 9,
  items: [
    {
      transaction_id: "t9",
      type: "CS01",
      date: "2025-06-14",
      category: "confirmation-statement",
      description: "confirmation-statement-with-no-updates",
      description_values: { made_up_date: "2025-06-01" },
      paper_filed: false,
      pages: 3,
      links: { self: "/company/00000001/filing-history/t9", document_metadata: "https://doc/t9" },
    },
    {
      transaction_id: "t8",
      type: "AA",
      date: "2025-03-02",
      category: "accounts",
      description: "accounts-with-accounts-type-micro-entity",
      description_values: { made_up_date: "2024-09-30" },
      paper_filed: false,
      pages: 8,
      links: { self: "/company/00000001/filing-history/t8", document_metadata: "https://doc/t8" },
    },
    {
      transaction_id: "t7",
      type: "MR01",
      date: "2024-11-20",
      category: "mortgage",
      description: "create-charge-with-deed",
      paper_filed: false,
      pages: 12,
      links: { self: "/company/00000001/filing-history/t7" },
    },
    {
      transaction_id: "t6",
      type: "TM01",
      date: "2024-08-01",
      category: "officers",
      description: "termination-director-company-with-name",
      description_values: { officer_name: "A Person" },
      paper_filed: false,
      links: { self: "/company/00000001/filing-history/t6" },
    },
    {
      transaction_id: "t5",
      type: "AP01",
      date: "2024-07-30",
      category: "officers",
      description: "appoint-person-director-company-with-name",
      description_values: { officer_name: "B Person" },
      paper_filed: false,
      links: { self: "/company/00000001/filing-history/t5" },
    },
    {
      transaction_id: "t4",
      type: "PSC01",
      date: "2023-05-05",
      category: "persons-with-significant-control",
      description: "psc-notification-individual",
      paper_filed: false,
      links: { self: "/company/00000001/filing-history/t4" },
    },
    {
      transaction_id: "t3",
      type: "SH01",
      date: "2022-02-14",
      category: "capital",
      description: "capital-allotment-shares",
      paper_filed: false,
      links: { self: "/company/00000001/filing-history/t3" },
    },
    {
      transaction_id: "t2",
      type: "GAZ1",
      date: "2021-09-09",
      category: "gazette",
      description: "gaz1-first-gazette-notice-for-compulsory-strike-off",
      paper_filed: false,
      links: { self: "/company/00000001/filing-history/t2" },
    },
    {
      transaction_id: "t1",
      type: "NEWINC",
      date: "2015-01-06",
      category: "incorporation",
      description: "incorporation-company",
      paper_filed: false,
      links: { self: "/company/00000001/filing-history/t1" },
    },
  ],
};

export const pscFixture = {
  active_count: 3,
  ceased_count: 1,
  total_results: 4,
  items_per_page: 100,
  start_index: 0,
  items: [
    {
      kind: "individual-person-with-significant-control",
      name: "Ms Verified Holder",
      nationality: "British",
      country_of_residence: "England",
      date_of_birth: { month: 4, year: 1975 },
      notified_on: "2016-04-06",
      natures_of_control: ["ownership-of-shares-75-to-100-percent", "voting-rights-75-to-100-percent"],
      identity_verification_details: {
        identity_verified_on: "2025-07-16",
        authorised_corporate_service_provider_name: "Example ACSP LLP",
        appointment_verification_statement_date: "2025-07-20",
      },
      links: { self: "/company/00000001/persons-with-significant-control/individual/1" },
    },
    {
      kind: "individual-person-with-significant-control",
      name: "Mr Pending Holder",
      nationality: "Irish",
      notified_on: "2020-01-15",
      natures_of_control: ["ownership-of-shares-25-to-50-percent-as-trust"],
      identity_verification_details: {
        appointment_verification_statement_due_on: "2026-01-15",
      },
      links: { self: "/company/00000001/persons-with-significant-control/individual/2" },
    },
    {
      kind: "corporate-entity-person-with-significant-control",
      name: "Holdco Limited",
      notified_on: "2019-03-03",
      natures_of_control: ["voting-rights-more-than-25-percent-registered-overseas-entity"],
      identification: { registration_number: "12345678", country_registered: "England" },
      links: { self: "/company/00000001/persons-with-significant-control/corporate-entity/3" },
    },
    {
      kind: "individual-person-with-significant-control",
      name: "Mr Former Holder",
      notified_on: "2016-04-06",
      ceased_on: "2019-03-03",
      natures_of_control: ["right-to-appoint-and-remove-directors"],
      links: { self: "/company/00000001/persons-with-significant-control/individual/4" },
    },
  ],
};

export const pscSuperSecureFixture = {
  active_count: 1,
  ceased_count: 0,
  total_results: 1,
  items: [
    {
      kind: "super-secure-person-with-significant-control",
      description: "super-secure-persons-with-significant-control",
      identity_verification_details: {
        appointment_verification_start_on: "2025-02-01",
        appointment_verification_end_on: "2026-02-01",
      },
    },
  ],
};

export const pscStatementsFixture = {
  active_count: 1,
  ceased_count: 0,
  total_results: 1,
  items: [
    {
      statement: "psc-exists-but-not-identified",
      notified_on: "2024-02-02",
      links: { self: "/company/00000001/persons-with-significant-control-statements/s1" },
    },
  ],
};

/**
 * A separate company with a capital history rich enough to exercise every
 * event type: incorporation, allotment, subdivision, redenomination,
 * consolidation, treasury cancellation, and a confirmation statement that
 * carries its own statement of capital.
 */
export const capitalFilingHistoryFixture = {
  filing_history_status: "filing-history-available",
  items_per_page: 100,
  start_index: 0,
  total_count: 9,
  items: [
    {
      transaction_id: "c9",
      type: "CS01",
      date: "2025-06-20",
      category: "confirmation-statement",
      description: "confirmation-statement-with-updates",
      description_values: { made_up_date: "2025-06-01", capital: [{ currency: "GBP", figure: "4,850,000" }] },
      links: { self: "/x", document_metadata: "https://doc/c9" },
    },
    {
      transaction_id: "c8",
      type: "AA",
      date: "2025-05-01",
      category: "accounts",
      description: "accounts-with-accounts-type-full",
      description_values: { made_up_date: "2024-12-31" },
      links: { self: "/x" },
    },
    {
      transaction_id: "c7",
      type: "SH06",
      date: "2025-04-05",
      category: "capital",
      description: "capital-cancellation-treasury-shares-with-date-currency-capital-figure",
      description_values: {
        date: "2025-04-01",
        capital: [{ currency: "GBP", figure: "4,850,000" }],
        alt_capital: [{ currency: "GBP", figure: "150,000" }],
      },
      links: { self: "/x", document_metadata: "https://doc/c7" },
    },
    {
      transaction_id: "c6",
      type: "SH01",
      date: "2024-09-20",
      category: "capital",
      description: "capital-allotment-shares",
      description_values: { date: "2024-09-15", capital: [{ currency: "GBP", figure: "5,000,000" }] },
      links: { self: "/x", document_metadata: "https://doc/c6" },
    },
    {
      transaction_id: "c5",
      type: "SH02",
      date: "2023-06-05",
      category: "capital",
      description: "capital-alter-shares-consolidation-subdivision-statement-of-capital",
      description_values: { date: "2023-06-01", capital: [{ currency: "GBP", figure: "4,000,000" }] },
      links: { self: "/x", document_metadata: "https://doc/c5" },
    },
    {
      transaction_id: "c4",
      type: "SH14",
      date: "2022-03-15",
      category: "capital",
      description: "capital-redomination-of-shares",
      description_values: { date: "2022-03-10", capital: [{ currency: "EUR", figure: "1,150,000" }] },
      links: { self: "/x", document_metadata: "https://doc/c4" },
    },
    {
      transaction_id: "c3",
      type: "SH19",
      date: "2021-08-12",
      category: "capital",
      description: "capital-statement-directors-reduction-of-capital-following-redomination",
      description_values: { date: "2021-08-01", capital: [{ currency: "GBP", figure: "900,000" }] },
      links: { self: "/x", document_metadata: "https://doc/c3" },
    },
    {
      transaction_id: "c2",
      type: "SH01",
      date: "2018-05-25",
      category: "capital",
      description: "capital-allotment-shares",
      description_values: { date: "2018-05-20", capital: [{ currency: "GBP", figure: "1,000,000" }] },
      links: { self: "/x", document_metadata: "https://doc/c2" },
    },
    {
      transaction_id: "c1",
      type: "NEWINC",
      date: "2015-01-06",
      category: "incorporation",
      description: "incorporation-company",
      description_values: { date: "2015-01-06", capital: [{ currency: "GBP", figure: "100" }] },
      links: { self: "/x", document_metadata: "https://doc/c1" },
    },
  ],
};
