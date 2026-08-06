// Paste your Google OAuth client ID here. See README.md, step 1.
// It looks like: 1234567890-abcdefghijklmnop.apps.googleusercontent.com
window.TODO_CONFIG = {
  GOOGLE_CLIENT_ID: "632543710902-8dlk3kka018mfs08nrfov748l8t257ue.apps.googleusercontent.com",

  // Where the data lives in your Drive. The app creates both on first run.
  FOLDER_NAME: "tododata",
  FILE_NAME: "todos.json",

  // Ranking dropdown runs 1..MAX_ITEMS, and the list is capped at that many items.
  MAX_ITEMS: 50,

  // How many finished items the "Nailed It!" tab keeps. Oldest drop off first.
  MAX_COMPLETED: 50,
};
