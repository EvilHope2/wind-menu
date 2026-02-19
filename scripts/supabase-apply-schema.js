require("dotenv").config();
const { applySupabaseSchema } = require("../src/sync/schema");

applySupabaseSchema()
  .then(() => {
    console.log("Schema aplicado correctamente en Supabase.");
  })
  .catch((err) => {
  console.error("Error aplicando schema:", err.message);
  process.exit(1);
  });
