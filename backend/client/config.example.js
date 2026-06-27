window.ENV = {
    // Local file:// access only. Do not deploy a browser-served config.js with SECRET_API_KEY.

    // The public URL of your Render backend (e.g., "https://my-ads-api.onrender.com")
    // Or "http://localhost:7860" for local testing.
    API_BASE: "",

    // The SECRET_API_KEY you configured in Render / .env
    API_KEY: "",

    // Optional: Your Hugging Face Access Token (only needed for accessing a Private Space)
    HF_TOKEN: ""
};
