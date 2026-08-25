/** Split comma-delimited path filters without splitting glob braces/classes. */
export function splitPathFilters(value: string): string[] {
  const filters: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      bracketDepth += 1;
      continue;
    }
    if (character === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }
    if (bracketDepth === 0 && character === "{") {
      braceDepth += 1;
      continue;
    }
    if (bracketDepth === 0 && character === "}" && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }
    if (character !== "," || braceDepth > 0 || bracketDepth > 0) continue;

    const filter = value.slice(start, index).trim();
    if (filter.length > 0) filters.push(filter);
    start = index + 1;
  }

  const finalFilter = value.slice(start).trim();
  if (finalFilter.length > 0) filters.push(finalFilter);
  return filters;
}

export function parseModifiedTime(value: string, option: string): number {
  if (/^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }

  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const year = Number.parseInt(dateOnly[1]!, 10);
    const month = Number.parseInt(dateOnly[2]!, 10);
    const day = Number.parseInt(dateOnly[3]!, 10);
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    ) {
      return date.getTime();
    }
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(
    `${option} requires an epoch millisecond value or a parseable date`,
  );
}
