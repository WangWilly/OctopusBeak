export const FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_METADATA = {
  yuanta: {
    authorityRoute: "yuanta/foreign-currency/deposit/v1",
    contractVersion: "foreign-currency/yuanta/v1",
    integrationNamespace: "yuanta",
    recordKind: "yuanta-foreign-currency-deposit",
    postingOrigin: "provider_booked_history",
  },
  cathay: {
    authorityRoute: "cathay/foreign-currency/deposit/v1",
    contractVersion: "foreign-currency/cathay/v1",
    integrationNamespace: "cathay",
    recordKind: "cathay-foreign-currency-deposit",
    postingOrigin: "provider_booked_history",
  },
  linebank: {
    authorityRoute: "linebank/foreign-currency/deposit/v1",
    contractVersion: "foreign-currency/linebank/v1",
    integrationNamespace: "linebank",
    recordKind: "linebank-foreign-currency-deposit",
    postingOrigin: "provider_booked_history",
  },
  sinopac: {
    authorityRoute: "sinopac/foreign-currency/deposit/human-attested-v1",
    contractVersion: "foreign-currency/sinopac/human-attested-v1",
    integrationNamespace: "sinopac",
    recordKind: "sinopac-foreign-currency-deposit",
    postingOrigin: "human-attested",
  },
} as const;

export const FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_ROUTES = Object.values(
  FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_METADATA,
).map((metadata) => metadata.authorityRoute);
