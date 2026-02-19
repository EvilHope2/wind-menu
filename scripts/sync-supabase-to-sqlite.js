require("dotenv").config();
const { pullSupabaseToSqlite } = require("../src/sync/bridge");

pullSupabaseToSqlite()
  .then(() => {
    console.log("Descarga completada.");
  })
  .catch((err) => {
    console.error("Error descargando:", err.message);
    process.exit(1);
  });
