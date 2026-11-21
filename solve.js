// Fast drop-in for csv-reader 1.0.0: run(input) returns {columns, rows, errors}
// with exactly the reference reader's semantics, but without its per-character
// loop.
//
// Thinking (how this is built, in my own words):
// The reference reader walks the text one character at a time and grows every
// field with `value += c`. That is the whole cost: for ~10 MB of CSV it is
// ~1.4 s of CPU. Almost every field, though, is boring: an unquoted run up to
// the next comma or line break, or a quoted run up to its closing quote with
// nothing special inside. So this parser jumps instead of stepping:
//   - An unquoted field is located with indexOf for ',' (a native scan) and
//     the record's cached line end, then taken with one slice. A '\r' can
//     only matter inside that short slice, so it is checked on the slice
//     itself, never with an unbounded scan over the rest of the text.
//   - A quoted field is located with indexOf for the next '"'. If the chunk
//     before it holds no CR/LF and the quote is not doubled, the chunk is the
//     value with one slice. Doubled quotes and embedded line breaks fall back
//     to a small normalising step for that chunk only.
//   - A whole record whose first line holds no quote at all is taken with one
//     split(',') (a trailing CRLF stripped first). Records with a quote, a
//     stray CR, or anything else go through the per-field parser.
//   - Field results reuse one scratch object instead of allocating a fresh
//     {value, ended, added} per field, and the line end is cached per record
//     instead of re-scanned per field; both keep the garbage collector quiet.
// Rare broken input (stray CR, unterminated quote, junk after a closing
// quote, short/long rows) is handled by the same slow steps the reference
// describes, in the same order, so the errors come out identical.
//
// Ended codes: 0 = comma, 1 = line break, 2 = end of text.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // Error for the record currently being read.
  let recordLine = 1;
  let recordRow = null;
  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // One scratch result, reused by every field read: callers use its fields
  // before the next read overwrites them, and never keep it.
  const res = { value: '', ended: 0, added: 0 };

  // Cached index of the next LF at or after the current field start, for
  // the record being read field by field. A quoted field can run past it,
  // so any quoted read invalidates it.
  let lineEnd = -1;
  let lineEndValid = false;
  function getLineEnd() {
    if (!lineEndValid) {
      lineEnd = text.indexOf('\n', pos);
      lineEndValid = true;
    }
    return lineEnd;
  }

  // Normalise one chunk taken from inside a quoted field: every CRLF and
  // every lone CR becomes one LF, and `line` advances once per line break.
  function normalise(chunk) {
    const norm = chunk.replace(/\r\n?/g, '\n');
    // Every line break is exactly one '\n' in norm now.
    line += norm.split('\n').length - 1;
    return norm;
  }

  // Append the stray-CR handling for a slice that is known to hold CRs:
  // every CR in `seg` is dropped and reported.
  function appendDroppingCR(value, seg) {
    let added = 0;
    let k = 0;
    for (;;) {
      const r = seg.indexOf('\r', k);
      if (r === -1) {
        value += seg.slice(k);
        added += seg.length - k;
        break;
      }
      value += seg.slice(k, r);
      added += r - k;
      pushError('stray_cr');
      k = r + 1;
    }
    return { value, added };
  }

  // Read an unquoted field starting at pos, with `init` already in the
  // value ('' normally, the opening quote for an unterminated quote, the
  // quoted content for junk after a closing quote). Writes into `res` and
  // returns it: `added` counts only the characters this call kept, which
  // is what decides a quote_junk error.
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    for (;;) {
      const c = text.indexOf(',', pos);
      const l = getLineEnd();
      let end;
      let kind; // 0 comma, 1 line break, 2 end of text
      if (c !== -1 && (l === -1 || c < l)) {
        end = c;
        kind = 0;
      } else if (l !== -1) {
        end = l;
        kind = 1;
      } else {
        end = n;
        kind = 2;
      }
      const seg = text.slice(pos, end);
      if (kind === 0) {
        // Any CR before a comma is stray: a CRLF would have ended the
        // field at its LF instead.
        if (seg.indexOf('\r') === -1) {
          value += seg;
          added += seg.length;
        } else {
          const r = appendDroppingCR(value, seg);
          value = r.value;
          added += r.added;
        }
        pos = end + 1;
        res.value = value;
        res.ended = 0;
        res.added = added;
        return res;
      }
      if (kind === 1) {
        const r = seg.indexOf('\r');
        if (r === -1) {
          value += seg;
          added += seg.length;
        } else if (r === seg.length - 1) {
          // Single trailing CR: this is the CRLF ending the line.
          value += seg.slice(0, -1);
          added += seg.length - 1;
        } else {
          // Stray CRs inside, plus a trailing CRLF if there is one.
          let body = seg;
          if (body.charCodeAt(body.length - 1) === 13) body = body.slice(0, -1);
          const out = appendDroppingCR(value, body);
          value = out.value;
          added += out.added;
        }
        pos = end + 1;
        line += 1;
        res.value = value;
        res.ended = 1;
        res.added = added;
        return res;
      }
      // End of text.
      if (seg.indexOf('\r') === -1) {
        value += seg;
        added += seg.length;
      } else {
        const out = appendDroppingCR(value, seg);
        value = out.value;
        added += out.added;
      }
      pos = n;
      res.value = value;
      res.ended = 2;
      res.added = added;
      return res;
    }
  }

  // Read a quoted field whose opening quote is at pos.
  function readQuoted() {
    lineEndValid = false;
    const open = pos;
    const openLine = line;
    let value = '';
    let cur = pos + 1;
    for (;;) {
      const q = text.indexOf('"', cur);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        return readUnquoted('"');
      }
      const seg = text.slice(cur, q);
      if (text.charCodeAt(q + 1) === 34) {
        // Doubled quote inside the field: one literal quote.
        value += seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1 ? seg : normalise(seg);
        value += '"';
        cur = q + 2;
        continue;
      }
      // The closing quote.
      value += seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1 ? seg : normalise(seg);
      pos = q + 1;
      break;
    }
    if (pos >= n) {
      res.value = value;
      res.ended = 2;
      res.added = 0;
      return res;
    }
    const ch = text.charCodeAt(pos);
    if (ch === 44) {
      pos += 1;
      res.value = value;
      res.ended = 0;
      res.added = 0;
      return res;
    }
    if (ch === 10) {
      pos += 1;
      line += 1;
      res.value = value;
      res.ended = 1;
      res.added = 0;
      return res;
    }
    if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      res.value = value;
      res.ended = 1;
      res.added = 0;
      return res;
    }
    // Junk follows the closing quote: appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) pushError('quote_junk');
    return junk;
  }

  // Finish one record: header, width, short/long padding or cutting.
  function finishRecord(fields) {
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

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const ch = text.charCodeAt(pos);
      if (ch === 10) {
        pos += 1;
        line += 1;
      } else if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: this record's first line holds no quote, so no quoted
    // field can open in it and the record ends at its line break.
    const nl = text.indexOf('\n', pos);
    const segEnd = nl === -1 ? n : nl;
    const seg = text.slice(pos, segEnd);
    if (seg.indexOf('"') === -1) {
      const r = seg.indexOf('\r');
      if (r === -1) {
        if (seg.length > 0) finishRecord(seg.split(','));
        pos = nl === -1 ? n : nl + 1;
        line += 1;
        continue;
      }
      if (r === seg.length - 1 && nl !== -1) {
        // Only a trailing CRLF.
        const body = seg.slice(0, -1);
        if (body.length > 0) finishRecord(body.split(','));
        pos = nl + 1;
        line += 1;
        continue;
      }
      // A stray CR somewhere: fall through to the per-field parser.
    }

    // Slow path: parse this record field by field.
    lineEndValid = false;
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === 0);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    finishRecord(fields);
  }

  return { columns: header ? columns ?? [] : null, rows, errors };
}
