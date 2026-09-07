"use client";

/**
 * A number field with an explicit sign toggle.
 *
 * iOS shows no minus key for `inputMode="numeric"` or `"decimal"`, so a plain number
 * input makes -110 and -3.5 literally untypeable on a phone — which is most of the
 * prices and half the lines in this app. Switching to a full text keyboard would fix
 * typing and make entry worse; a tap target for the sign keeps the numeric keypad and
 * removes the trap.
 *
 * The value is exposed as a signed string so callers see exactly what a text field
 * would have produced.
 */
export function SignedInput({
  value,
  onChange,
  step = "1",
  placeholder,
  label,
  positiveLabel = "+",
  negativeLabel = "−",
}: {
  value: string;
  onChange: (next: string) => void;
  step?: string;
  placeholder?: string;
  label: string;
  positiveLabel?: string;
  negativeLabel?: string;
}) {
  const negative = value.trim().startsWith("-");
  const magnitude = value.replace(/^[+-]/, "");

  function setSign(nextNegative: boolean) {
    // Toggling with the field empty should still register, so the sign survives until
    // digits arrive rather than being silently dropped.
    onChange(nextNegative ? `-${magnitude}` : magnitude);
  }

  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
      <div className="mt-1 flex gap-1">
        <div
          className="flex shrink-0 overflow-hidden rounded-lg border border-edge"
          role="group"
          aria-label={`${label} sign`}
        >
          <button
            type="button"
            onClick={() => setSign(true)}
            aria-pressed={negative}
            className={`w-8 text-[15px] font-semibold transition-colors ${
              negative ? "bg-sky-500/20 text-sky-300" : "text-slate-500"
            }`}
          >
            {negativeLabel}
          </button>
          <button
            type="button"
            onClick={() => setSign(false)}
            aria-pressed={!negative}
            className={`w-8 border-l border-edge text-[15px] font-semibold transition-colors ${
              !negative ? "bg-sky-500/20 text-sky-300" : "text-slate-500"
            }`}
          >
            {positiveLabel}
          </button>
        </div>
        <input
          type="text"
          inputMode="decimal"
          step={step}
          value={magnitude}
          onChange={(e) => {
            // Keep only digits and a single decimal point; the buttons own the sign.
            const cleaned = e.target.value.replace(/[^0-9.]/g, "");
            onChange(negative && cleaned ? `-${cleaned}` : cleaned);
          }}
          placeholder={placeholder}
          className="tabular w-full rounded-lg border border-edge bg-ink px-2 py-1.5 text-[13px] text-slate-100 outline-none focus:border-sky-600"
        />
      </div>
    </label>
  );
}
