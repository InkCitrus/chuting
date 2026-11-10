# Security Policy

## Supported versions

Only the live site at https://chuting.inkorange.com and the latest `main` get security fixes.

## Reporting a vulnerability

Please report security problems privately rather than in a public issue: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/InkCitrus/chuting/security/advisories/new)).

It helps to include:

- whether it affects the live site, the local Python version, or both;
- what happens, and the steps to reproduce it;
- your browser and OS if it is a client-side issue.

Please don't include your own NetEase Cloud Music cookies, session tokens or exported archive in the report.

This is a spare-time project, so expect a first reply within a week. Once a fix is released, the advisory is published, with credit to you if you'd like.

## Scope

In scope: the web app in `web/`, the API proxy in `functions/` and `cloudflare/`, the optional fallback proxy in `server/`, the local Python server, and the build and deploy workflow. On the live site, the listening archive stays in your browser. The proxies forward requests to NetEase Cloud Music and do not keep that archive, login cookies, or session tokens. The Cloudflare proxy may cache public catalogue answers that are not tied to an account: trimmed song details, and artist-search names and portraits. The local Python server keeps the archive in a SQLite database on the machine that runs it, along with the raw responses it saved. Bugs in NetEase Cloud Music itself, Cloudflare, or browsers are out of scope and are best reported to those vendors.
