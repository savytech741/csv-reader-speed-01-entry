// Fast drop-in for csv-reader 1.0.0, make.fun's own reference CSV reader.
// Returns exactly csv-reader's answer {columns, rows, errors} for every input,
// built for CPU speed: a record-level fast path (split on commas when a record
// holds no quote and no stray CR), indexOf-driven field scans otherwise, and no
// per-character string building anywhere on the hot path. Every search is bounded
// to the field or record it decides, so a missing delimiter never scans past it.
//
// The reading, as csv-reader 1.0.0 does it: the text is read once, left to right.
// A U+FEFF at its very start is dropped. A record ends at LF or CRLF, and a line
// left with no characters is no record. Outside quotes a CR not followed by LF is
// dropped (stray_cr). A field opening with a quote runs to the next non-doubled
// quote, "" inside it one quote, each CRLF or lone CR inside it read as LF; what
// follows its closing quote, up to the next comma or line break, is appended as it
// stands (quote_junk, when the field ends); a quote that never closes is a literal
// and the text after it is re-read as unquoted (unterminated_quote). A quote inside
// an unquoted field is a literal. Fields stay strings, never trimmed or converted.
// columns is the first record when header is true, else null; rows holds the
// records after it, each padded with "" (short_row, fields: its count) or cut
// (long_row, extra: the cut fields) to the first record's width. Each error is
// {code, line, row}, in the order met; line is the 1-based line its record starts
// on, counting every LF, CRLF and lone CR inside quotes, and row its record's
// index in rows, null for the header.

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Append `seg` to value, turning each CRLF or lone CR inside it into one LF
  // and counting lines. `seg` holds at least one line break.
  function appendSegment(value, seg) {
    let q = 0;
    const m = seg.length;
    for (;;) {
      const iN = seg.indexOf('\n', q);
      const iR = seg.indexOf('\r', q);
      let i = -1;
      let isCR = false;
      if (iN !== -1) i = iN;
      if (iR !== -1 && (i === -1 || iR < i)) {
        i = iR;
        isCR = true;
      }
      if (i === -1) return value + seg.slice(q, m);
      value += seg.slice(q, i) + '\n';
      line++;
      q = isCR && seg.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
    }
  }

  // Read an unquoted field from pos, starting with `value` already built.
  // Returns [value, ended]: 0 = comma, 1 = line break, 2 = end of text.
  function unquoted(value, recordLine, recordRow) {
    for (;;) {
      const iC = text.indexOf(',', pos);
      const iN = text.indexOf('\n', pos);
      let i = -1;
      let kind = 0;
      if (iC !== -1 && (iN === -1 || iC < iN)) {
        i = iC;
        kind = 0;
      } else if (iN !== -1) {
        i = iN;
        kind = 1;
      }
      if (i === -1) {
        // The rest of the text; it may still hold stray CRs.
        const tail = text.slice(pos);
        const r = tail.indexOf('\r');
        if (r === -1) {
          value += tail;
          pos = n;
          return [value, 2];
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        value += tail.slice(0, r);
        pos += r + 1;
        continue;
      }
      if (kind === 1) {
        const crlf = i > pos && text.charCodeAt(i - 1) === 13;
        const seg = text.slice(pos, crlf ? i - 1 : i);
        const r = seg.indexOf('\r');
        if (r === -1) {
          value += seg;
          pos = i + 1;
          line++;
          return [value, 1];
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        value += seg.slice(0, r);
        pos += r + 1;
        continue;
      }
      const seg = text.slice(pos, i);
      const r = seg.indexOf('\r');
      if (r === -1) {
        value += seg;
        pos = i + 1;
        return [value, 0];
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      value += seg.slice(0, r);
      pos += r + 1;
    }
  }

  // Read a quoted field; pos is at its opening quote. Returns [value, ended].
  function quoted(recordLine, recordRow) {
    const open = pos;
    const openLine = line;
    let value = '';
    let p = pos + 1;
    for (;;) {
      const j = text.indexOf('"', p);
      if (j === -1) {
        // The quote never closes: it is a literal, the rest re-read as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return unquoted('"', recordLine, recordRow);
      }
      const seg = text.slice(p, j);
      if (text.charCodeAt(j + 1) === 34) {
        // Doubled quote: one literal quote.
        if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) value += seg;
        else value = appendSegment(value, seg);
        value += '"';
        p = j + 2;
        continue;
      }
      // The closing quote is at j.
      if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) value += seg;
      else value = appendSegment(value, seg);
      pos = j + 1;
      if (pos >= n) return [value, 2];
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos++;
        return [value, 0];
      }
      if (c === 10) {
        pos++;
        line++;
        return [value, 1];
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
        return [value, 1];
      }
      // Junk after the closing quote, up to the next comma or line break.
      const r = unquoted(value, recordLine, recordRow);
      if (r[0].length > value.length) {
        errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      }
      return r;
    }
  }

  // Finish a record: header, or a row padded/cut to the first record's width.
  function finishRecord(fields, recordLine, recordRow) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  records: while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // Fast path: a whole record with no quote and no stray CR. Its fields are
    // exactly the comma-separated slices, split in one call.
    const iN = text.indexOf('\n', pos);
    if (iN !== -1) {
      const crlf = iN > pos && text.charCodeAt(iN - 1) === 13;
      const rec = text.slice(pos, crlf ? iN - 1 : iN);
      if (rec.indexOf('"') === -1 && rec.indexOf('\r') === -1) {
        const fields = rec.split(',');
        pos = iN + 1;
        line++;
        finishRecord(fields, recordLine, recordRow);
        continue records;
      }
    }

    // Slow path: field by field.
    const fields = [];
    let quotedLast = false;
    let ended = 2;
    for (;;) {
      let value;
      if (text.charCodeAt(pos) === 34) {
        quotedLast = true;
        const res = quoted(recordLine, recordRow);
        value = res[0];
        ended = res[1];
      } else {
        quotedLast = false;
        const iC = text.indexOf(',', pos);
        const iL = text.indexOf('\n', pos);
        let i = -1;
        let kind = 0;
        if (iC !== -1 && (iL === -1 || iC < iL)) {
          i = iC;
          kind = 0;
        } else if (iL !== -1) {
          i = iL;
          kind = 1;
        }
        if (i === -1) {
          const seg = text.slice(pos);
          if (seg.indexOf('\r') === -1) {
            value = seg;
            pos = n;
            ended = 2;
          } else {
            const res = unquoted('', recordLine, recordRow);
            value = res[0];
            ended = res[1];
          }
        } else if (kind === 0) {
          const seg = text.slice(pos, i);
          if (seg.indexOf('\r') === -1) {
            value = seg;
            pos = i + 1;
            ended = 0;
          } else {
            const res = unquoted('', recordLine, recordRow);
            value = res[0];
            ended = res[1];
          }
        } else {
          const crlf = i > pos && text.charCodeAt(i - 1) === 13;
          const seg = text.slice(pos, crlf ? i - 1 : i);
          if (seg.indexOf('\r') === -1) {
            value = seg;
            pos = i + 1;
            line++;
            ended = 1;
          } else {
            const res = unquoted('', recordLine, recordRow);
            value = res[0];
            ended = res[1];
          }
        }
      }
      fields.push(value);
      if (ended !== 0) break;
    }

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quotedLast) continue records;
    finishRecord(fields, recordLine, recordRow);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
