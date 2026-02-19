require("dotenv").config();
const { pushSqliteToSupabase } = require("../src/sync/bridge");

pushSqliteToSupabase()
  .then(() => {
    console.log("Sincronizacion completada.");
  })
  .catch((err) => {
    console.error("Error sincronizando:", err.message);
    process.exit(1);
  });
