/** Format a phone value as a US number: +1 (555) 123-4567 */
function nationalDigits(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('1') && (digits.length > 10 || String(value ?? '').includes('+'))) {
    digits = digits.slice(1);
  }
  return digits.slice(0, 10);
}

function applyFormat(digits) {
  if (!digits) return '';
  const area = digits.slice(0, 3);
  const prefix = digits.slice(3, 6);
  const line = digits.slice(6, 10);
  if (digits.length < 3) return `+1 (${area}`;
  if (digits.length === 3) return `+1 (${area})`;
  if (digits.length < 7) return `+1 (${area}) ${prefix}`;
  return `+1 (${area}) ${prefix}-${line}`;
}

function deletedFormattingChar(raw, formatted) {
  if (!String(raw).startsWith('+1') || formatted.length !== String(raw).length + 1) return false;
  let i = 0;
  let extra = 0;
  for (let j = 0; j < formatted.length; j++) {
    if (i < raw.length && raw[i] === formatted[j]) i++;
    else extra++;
  }
  return extra === 1 && i === raw.length;
}

export function formatUsPhone(value) {
  const digits = nationalDigits(value);
  const formatted = applyFormat(digits);
  if (deletedFormattingChar(value, formatted)) {
    return applyFormat(digits.slice(0, -1));
  }
  return formatted;
}

export function withFormattedPhone(details) {
  if (!details || typeof details !== 'object' || details.phone == null || details.phone === '') {
    return details;
  }
  return { ...details, phone: formatUsPhone(details.phone) };
}
