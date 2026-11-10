const https = require("https");
const http = require("http");
const fs = require("fs");

// Keep the existing source calendars here. For better security, move these
// subscription URLs into GitHub Actions secrets before making the repository public.
const urls = [
  { name: "iCloud Calendar", url: process.env.ICLOUD_ICS_URL },
  { name: "Applerouth", url: process.env.APPLEROUTH_ICS_URL },
  { name: "Google Calendar", url: process.env.GOOGLE_ICS_URL },
  { name: "Runna", url: process.env.RUNNA_ICS_URL },
  { name: "Partiful", url: process.env.PARTIFUL_ICS_URL }
];

function normalizeCalendarUrl(url) {
  // Apple Calendar commonly copies public iCloud subscriptions as webcal://.
  // webcal is a subscription-handler scheme, not an HTTP transport supported
  // by Node's https client, so fetch the same published resource over HTTPS.
  const trimmed = String(url || "").trim();
  if (/^webcal:\/\//i.test(trimmed)) return trimmed.replace(/^webcal:/i, "https:");
  if (/^webcals:\/\//i.test(trimmed)) return trimmed.replace(/^webcals:/i, "https:");
  return trimmed;
}

function fetchICS(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    url = normalizeCalendarUrl(url);
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) {
      return reject(new Error(`Unsupported calendar URL protocol: ${parsed.protocol}`));
    }
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.get(url, {
      headers: {
        "User-Agent": "calendar-merge/2.0",
        Accept: "text/calendar,text/plain,*/*"
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error(`Too many redirects: ${url}`));
        const next = new URL(res.headers.location, url).href;
        return resolve(fetchICS(next, redirects - 1));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} while fetching ${url}`));
      }

      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve(data));
    });

    req.setTimeout(20000, () => req.destroy(new Error(`Request timed out: ${url}`)));
    req.on("error", reject);
  });
}

function unfoldLines(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const unfolded = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

// Extract complete direct VCALENDAR children. VEVENTs retain nested VALARMs;
// VTIMEZONE definitions are retained separately so TZID references keep working.
function parseCalendar(text, sourceName) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const unfolded = unfoldLines(text);
  if (!unfolded.includes("BEGIN:VCALENDAR") || !unfolded.includes("END:VCALENDAR")) {
    throw new Error(`${sourceName} did not return a complete VCALENDAR document`);
  }

  const events = [];
  const timezones = [];
  const stack = [];
  let capture = null;
  let captureDepth = 0;
  let rawIndex = 0;

  for (const line of lines) {
    const begin = /^BEGIN:([A-Z0-9-]+)$/i.exec(line);
    const end = /^END:([A-Z0-9-]+)$/i.exec(line);

    if (begin) {
      const component = begin[1].toUpperCase();
      const parent = stack[stack.length - 1];
      if (parent === "VCALENDAR" && (component === "VEVENT" || component === "VTIMEZONE")) {
        capture = { type: component, lines: [line] };
        captureDepth = stack.length + 1;
      } else if (capture) {
        capture.lines.push(line);
      }
      stack.push(component);
    } else if (end) {
      if (capture) capture.lines.push(line);
      const component = end[1].toUpperCase();
      const popped = stack.pop();
      if (popped !== component) {
        throw new Error(`${sourceName} contains mismatched component boundaries near ${line}`);
      }
      if (capture && stack.length + 1 === captureDepth && component === capture.type) {
        const block = capture.lines.join("\r\n");
        if (capture.type === "VEVENT") events.push({ raw: block, source: sourceName });
        else timezones.push(block);
        capture = null;
      }
    } else if (capture) {
      capture.lines.push(line);
    }
    rawIndex++;
  }

  if (stack.length || capture) throw new Error(`${sourceName} contains an incomplete calendar component`);
  return { events, timezones };
}

function propertyValues(eventText, propertyName) {
  const lines = unfoldLines(eventText);
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped}(?:;[^:]*)?:(.*)$`, "i");
  return lines.map(line => regex.exec(line)).filter(Boolean).map(match => match[1]);
}

function eventInfo(item) {
  const uid = propertyValues(item.raw, "UID")[0] || "";
  const startLine = unfoldLines(item.raw).find(line => /^DTSTART(?:;[^:]*)?:/i.test(line)) || "";
  const recurrenceLine = unfoldLines(item.raw).find(line => /^RECURRENCE-ID(?:;[^:]*)?:/i.test(line)) || "";
  const start = startLine.replace(/^DTSTART(?:;[^:]*)?:/i, "");
  const recurrence = recurrenceLine.replace(/^RECURRENCE-ID(?:;[^:]*)?:/i, "");
  const summary = propertyValues(item.raw, "SUMMARY")[0] || "";
  const end = propertyValues(item.raw, "DTEND")[0] || propertyValues(item.raw, "DURATION")[0] || "";
  const location = propertyValues(item.raw, "LOCATION")[0] || "";
  const status = (propertyValues(item.raw, "STATUS")[0] || "").toUpperCase();
  const sequence = Number(propertyValues(item.raw, "SEQUENCE")[0] || 0);
  const modified = propertyValues(item.raw, "LAST-MODIFIED")[0] || propertyValues(item.raw, "DTSTAMP")[0] || "";
  const identity = uid ? `${uid}|${recurrence}|${start}` : "";
  const duplicateFingerprint = [summary, startLine.replace(/^DTSTART/i, "DTSTART"), end, location]
    .map(value => value.trim().toLocaleLowerCase()).join("|" );
  return { uid, start, end, identity, duplicateFingerprint, status, sequence, modified, summary };
}

function compareRevision(a, b) {
  const ai = eventInfo(a);
  const bi = eventInfo(b);
  if (ai.sequence !== bi.sequence) return ai.sequence - bi.sequence;
  return ai.modified.localeCompare(bi.modified);
}

function tagApplerouth(item) {
  if (item.source !== "Applerouth") return item;
  const lines = item.raw.split("\r\n");
  const index = lines.findIndex(line => /^SUMMARY(?:;[^:]*)?:/i.test(line));
  if (index >= 0 && !/^SUMMARY(?:;[^:]*)?:Tutoring:/i.test(lines[index])) {
    lines[index] = lines[index].replace(/^(SUMMARY(?:;[^:]*)?:)/i, "$1Tutoring: ");
  }
  return { ...item, raw: lines.join("\r\n") };
}

function mergeEvents(sourceEvents) {
  const selected = new Map();
  const fingerprints = new Map();

  for (const original of sourceEvents) {
    const info = eventInfo(original);
    if (info.status === "CANCELLED") continue;
    const item = tagApplerouth(original);

    // Same UID + recurrence instance + start is one event identity. DTSTART is
    // included because some source feeds reuse UIDs for separate one-off events.
    const identity = info.identity || `fallback:${info.duplicateFingerprint}`;
    if (selected.has(identity)) {
      if (compareRevision(item, selected.get(identity)) > 0) selected.set(identity, item);
      continue;
    }

    // Some providers assign different UIDs to the same imported appointment.
    // Collapse only an exact summary/start/end/location match; different dates,
    // times, or locations remain separate even when the UID is reused.
    const fingerprint = info.duplicateFingerprint;
    const previousIdentity = fingerprints.get(fingerprint);
    if (previousIdentity && info.summary && info.start && info.end) {
      const previous = selected.get(previousIdentity);
      if (previous && compareRevision(item, previous) > 0) {
        selected.delete(previousIdentity);
        item._identity = identity;
        selected.set(identity, item);
        fingerprints.set(fingerprint, identity);
      }
      continue;
    }

    item._identity = identity;
    selected.set(identity, item);
    if (info.summary && info.start && info.end) fingerprints.set(fingerprint, identity);
  }

  return [...selected.values()].map(item => item.raw);
}

function dedupeTimezones(timezones) {
  const byTzid = new Map();
  for (const block of timezones) {
    const tzid = propertyValues(block, "TZID")[0] || block;
    if (!byTzid.has(tzid)) byTzid.set(tzid, block);
  }
  return [...byTzid.values()];
}

async function main() {
  const missing = urls.filter(source => !source.url);
  if (missing.length) {
    throw new Error(`Missing GitHub Actions secrets for: ${missing.map(source => source.name).join(", ")}`);
  }

  console.log(`Fetching ${urls.length} source calendars...`);

  // Fail the entire build if any source is unavailable or invalid. This avoids
  // silently publishing a partial feed that looks like events were deleted.
  const sourceResults = await Promise.all(urls.map(async source => {
    const content = await fetchICS(source.url);
    const parsed = parseCalendar(content, source.name);
    console.log(`${source.name}: ${parsed.events.length} events, ${parsed.timezones.length} timezones`);
    return parsed;
  }));

  const allEvents = sourceResults.flatMap(result => result.events);
  const allTimezones = dedupeTimezones(sourceResults.flatMap(result => result.timezones));
  const mergedEvents = mergeEvents(allEvents);

  const output = [
    "BEGIN:VCALENDAR",
    "PRODID:-//rhoadsco//Calendar Merge//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    ...allTimezones,
    ...mergedEvents,
    "END:VCALENDAR",
    ""
  ].join("\r\n");

  const tempPath = "merged.ics.tmp";
  fs.writeFileSync(tempPath, output, "utf8");
  fs.renameSync(tempPath, "merged.ics");

  console.log(`Successfully published ${mergedEvents.length} events (${allEvents.length - mergedEvents.length} removed as duplicates/cancellations).`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Calendar merge failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { normalizeCalendarUrl, fetchICS, unfoldLines, parseCalendar, propertyValues, eventInfo, mergeEvents, dedupeTimezones };
