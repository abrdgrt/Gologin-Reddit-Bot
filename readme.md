
# Reddit Signup Automation

Automates Reddit account creation using Puppeteer and GoLogin for browser fingerprinting, handling gender selection, topic interests, and session management.

## Features
- Generates unique usernames (e.g., "FionaJames304") without "Bot" prefix using `faker`.
- Selects gender and topics during Reddit onboarding.
- Uses GoLogin to create new profiles or reuse existing ones, saving session cookies.
- Robust error handling with retries, screenshots, and logs.

## Prerequisites
- **Node.js**: v16+ recommended.
- **Dependencies**: Install via `npm install puppeteer gologin faker fs`.
- **GoLogin Token**: Obtain from [GoLogin dashboard](https://app.gologin.com).

## Setup
1. Clone the repo:
   ```bash
   git clone <repo-url>
   cd reddit-signup-automation
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure `config` object in your script:
   ```javascript
   const config = {
     goLoginToken: 'your-gologin-token',
     goLoginProfileId: null,        // Set dynamically or specify existing ID
     useNewProfile: true,           // True for new profiles each run
     genderChoice: 0,               // 0-3 (modulo applied)
     topicCategory: 1,              // Category index (modulo applied)
     numTopics: 2,                  // Number of topics to select
     topicIndices: [0, 3],          // Specific topic indices (optional)
     validateClicks: true,          // Validate selections
   };
   ```

## Usage
1. Run the script:
   ```bash
   node script.js
   ```
2. Check logs in console and `logs/` folder for screenshots on errors.
3. Accounts saved to `accounts.txt` in format `username:password:email`.

## How It Works
- **Browser Launch**: Initializes a GoLogin profile and launches Puppeteer.
- **Signup**: Enters username/password, selects gender, and picks topics from a category (e.g., "Trending") using `fieldset:nth-child(n) > div.topic-container:nth-child(m)` selectors.
- **Session Save**: Stores cookies to GoLogin profile post-signup.
- **Verification**: Confirms account creation by detecting the feed (`shreddit-post`).

## Key Selectors
- **Shadow DOM Root**: `body > shreddit-app > auth-flow-manager > span[slot="onboarding"] > faceplate-partial > onboarding-flow > shreddit-slotter`.
- **Topics**: `#topics > fieldset:nth-child(n) > div > div.topic-container:nth-child(m) > button[role="checkbox"]`.

## Troubleshooting
- **"INVALID TOKEN"**: Verify `goLoginToken` in config.
- **"Element not found"**: Check `logs/error-*.png` for DOM state; adjust `SLOTTER_SELECTOR` if Reddit’s structure changes.
- **Profile Issues**: Ensure `useNewProfile` is set correctly or provide a valid `goLoginProfileId`.

## License