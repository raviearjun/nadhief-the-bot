// Only digits, arithmetic operators, parens, dot, % and ^ pass the filter —
// no letters means no identifiers, so feeding it to Function() is safe.
const SAFE_EXPR_RE = /^[0-9+\-*/().%\s^]+$/;

function evaluate(expression) {
  const expr = String(expression ?? "").trim();
  if (!expr || expr.length > 200 || !SAFE_EXPR_RE.test(expr)) {
    return { error: "expression must contain only numbers and + - * / ( ) . % ^" };
  }
  try {
    const value = new Function(`"use strict"; return (${expr.replace(/\^/g, "**")});`)();
    if (typeof value !== "number" || !Number.isFinite(value)) return { error: "expression did not produce a number" };
    return { result: value };
  } catch {
    return { error: "invalid expression" };
  }
}

export function skills() {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "calculator",
          description:
            "Evaluate an arithmetic expression exactly (numbers with + - * / ( ) . % ^). " +
            "Use this for any non-trivial calculation instead of doing mental math.",
          parameters: {
            type: "object",
            properties: {
              expression: { type: "string", description: "e.g. \"(1250000 * 0.15) + 45000\"" },
            },
            required: ["expression"],
          },
        },
      },
      execute: ({ expression }) => evaluate(expression),
    },
  ];
}
