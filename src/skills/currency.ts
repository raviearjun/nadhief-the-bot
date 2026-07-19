const REQUEST_TIMEOUT_MS = 15_000;

// open.er-api.com — free, no API key, daily-updated mid-market rates
async function convert(amount, from, to) {
  const base = String(from || "").toUpperCase();
  const target = String(to || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(target)) {
    return { error: "from/to must be 3-letter currency codes like USD, IDR, EUR" };
  }

  const res = await fetch(`https://open.er-api.com/v6/latest/${base}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return { error: `exchange rate fetch failed with status ${res.status}` };
  const data = await res.json() as any;
  if (data.result !== "success") return { error: `unknown base currency ${base}` };

  const rate = data.rates?.[target];
  if (!rate) return { error: `unknown target currency ${target}` };

  const amt = Number(amount);
  if (!Number.isFinite(amt)) return { error: "amount must be a number" };

  return {
    from: base,
    to: target,
    rate,
    amount: amt,
    converted: amt * rate,
    last_updated: data.time_last_update_utc,
  };
}

export function skills() {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "convert_currency",
          description:
            "Convert an amount between currencies using live exchange rates (e.g. USD to IDR). " +
            "Use for any exchange-rate or kurs question instead of guessing.",
          parameters: {
            type: "object",
            properties: {
              amount: { type: "number", description: "Amount in the source currency" },
              from: { type: "string", description: "Source currency code, e.g. USD" },
              to: { type: "string", description: "Target currency code, e.g. IDR" },
            },
            required: ["amount", "from", "to"],
          },
        },
      },
      execute: ({ amount, from, to }) => convert(amount, from, to),
    },
  ];
}
