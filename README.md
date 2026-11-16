# resend-smtp

A small local mailbox for Resend.

It lets you sync a domain inbox, send mail from an address on a verified Resend domain, and send a CSV list. Everything stays on your machine. Received mail, sent mail, and bulk jobs are saved in `data/app.json`.

This is not a hosted app. You run it locally, then open `http://localhost:3000`.

## Why a local server?

The page is plain HTML, CSS, and JavaScript. The tiny Node server exists so your Resend API key stays out of the browser. Opening `index.html` directly will not work, because Resend does not allow browser calls.

## Setup

You need Node.js 22 or newer.

```bash
npm install
cp .env.example .env
```

Put your key in `.env`:

```bash
RESEND_API_KEY=re_your_api_key_here
```

Get one from [resend.com/api-keys](https://resend.com/api-keys). The key needs access to sending, receiving, and domains.

Then start it:

```bash
npm run dev
```

Open `http://localhost:3000`.

If you change `.env` while the server is running, stop it and start it again. The running process keeps the old key.

## What you can do

- Sync received mail for the domains your API key can access
- Filter the local inbox by address or domain
- Send one email to one or more people
- Import a CSV and send it in chunks

The from address has to be on a verified Resend domain, like `info@yourdomain.com`.

## CSV

The CSV needs an `email` or `to` column.

Optional columns:

- `subject`
- `text`
- `html`

If a row does not have those, the form defaults are used.

```csv
email,subject,text
ada@example.com,Hello,Hi Ada
grace@example.com,Hello,Hi Grace
```

## Notes

- Do not commit `.env`. It holds your API key.
- `data/` is local app data and is gitignored.
- SMTP fields in `.env` are optional notes. Sending goes through the Resend API.

## License

MIT. See [LICENSE](LICENSE).
