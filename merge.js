const https = require("https");
const http = require("http");
const fs = require("fs");

const urls = [
  {
    name: "iCloud Calendar",
    url: "https://p186-caldav.icloud.com/published/2/NjA2MTM3MTM4NjA2MTM3MXaMhow2Ok5zC_yckLapv8D69B6ZwlzmYvASpALtrwA5kmS3l7DQNbRqMJZHuJVkRlhOjFmZ77DSLuLXWMAhTZc"
  },
  {
    name: "Applerouth",
    url: "https://guidewelleducation.onecanoe.com/api/applerouth/calendar/subscribe?filter%5Bpeople%5D%5B0%5D=1454132&timezone=America%2FNew_York&signature=70b4c2f6352249b775e17cad066e5dd8b949f347033d63b8d916012c43935f27"
  },
  {
    name: "Google Calendar",
    url: "https://calendar.google.com/calendar/ical/cosetterhoads9%40gmail.com/private/full.ics"
  }
];

// 🔁 Fetch ICS with redirect + timeout + safety
function fetchICS(url, redirects = 5) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;

    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/calendar,*/*"
      },
      timeout: 10000
    };

    const req = lib.get(url, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects === 0) return resolve("");

        const nextUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;

        return resolve(fetchICS(nextUrl, redirects - 1));
      }

      let data = "";

      res.on("data", chunk => data += chunk);

      res.on("end", () => {
        if (res.statusCode !== 200) {
          console.log(`Failed (${res.statusCode}): ${url}`);
          return resolve("");
        }
        resolve(data);
      });
    });

    req.on("timeout", () => {
      req.destroy();
      console.log(`Timeout: ${url}`);
      resolve("");
    });

    req.on("error", (err) => {
      console.log(`Error: ${url} -> ${err.message}`);
      resolve("");
    });
  });
}

// 🧹 Extract ONLY VEVENT blocks (fixes Google Calendar issue)
function extractEvents(content) {
  return content
    .replace(/BEGIN:VCALENDAR/g, "")
    .replace(/END:VCALENDAR/g, "")
    .split("BEGIN:VEVENT")
    .slice(1)
    .map(e => "BEGIN:VEVENT" + e);
}

// 🏷 Tag each event with team name
function tagEvents(events, label) {
  return events;
}

(async () => {
  console.log("Fetching calendars...");

  const files = await Promise.all(
    urls.map(async (u) => {
      const data = await fetchICS(u.url);
      console.log(`${u.name}: ${data.length} chars`);
      return data;
    })
  );

  const events = files
    .map((file, i) => {
      if (!file) return [];

      const extracted = extractEvents(file);
      return tagEvents(extracted, urls[i].name);
    })
    .flat();

  console.log(`Total events merged: ${events.length}`);

  const merged = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    ...events,
    "END:VCALENDAR"
  ].join("\n");

  fs.writeFileSync("merged.ics", merged);

  console.log("merged.ics updated successfully");
})();
