# FOJ / EHRA — ZefixPublicREST credentials

**To:** the Federal Commercial Registry Office (EHRA, Eidgenössisches Amt für das Handelsregister)
at the Federal Office of Justice. Use the contact address published on the ZefixPublicREST
documentation page (`https://www.zefix.admin.ch/ZefixPublicREST/`) or on the EHRA/Zefix contact
page at `bj.admin.ch`. The credential-request address is given there. Don't guess it.

**Subject:** Request for ZefixPublicREST API credentials — Swissyphus (open-source server for Swiss public data)

---

Dear Sir or Madam,

I maintain **Swissyphus** (https://github.com/cwellbournewood/swissyphus). It is an open-source
(MIT) server that gives AI assistants and developers structured, attributed access to Swiss public
data, including the commercial register. It runs locally for individual users, and I also plan a
small hosted API in Switzerland at [HOSTED URL], with a soft launch planned for [DATE].

The company tools currently call the `ZefixREST` endpoints behind the zefix.ch web application
without credentials. I understand that **ZefixPublicREST** is the supported interface for
machine access, and I would like to move to it. I would therefore like to ask:

1. Could you issue **ZefixPublicREST credentials** (Basic auth) for the Swissyphus project?
2. Are there **terms of use** I should follow for a hosted service that shows register
   excerpts (company name, UID, legal form, seat, purpose, status, SOGC references) to third-party
   users, with attribution "© ZEFIX, Federal Office of Justice" and a link to the official entry?
3. Are there **rate or volume limits** I should respect? Responses are cached for one hour, and
   repeated identical queries are coalesced, so upstream traffic is expected to be low
   ([ESTIMATE, e.g. a few thousand requests per day at most]).
4. Is the canonical list of **legal forms** (`/legalForm`) available through ZefixPublicREST? I
   would like to fetch it rather than hard-code it.

Until credentials are issued, the hosted service will keep request volume minimal and will
switch over as soon as access is granted.

Thank you for your time and for making the register openly accessible.

Kind regards,
Connor Wellbourne-Wood
Maintainer, Swissyphus
[contact email] · https://github.com/cwellbournewood/swissyphus

---

**When a reply arrives:** record it in the tracker (`README.md`, row 1). If credentials are
granted, store them only in `deploy/.env` on the VPS (`ZEFIX_USER`, `ZEFIX_PASS`), never in the
repo, and confirm that `search_companies` works against ZefixPublicREST.
