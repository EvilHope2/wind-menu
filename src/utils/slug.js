function slugify(input) {
  return String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function uniqueSlug(baseSlug, existsFn) {
  const clean = baseSlug || "comercio";
  if (!existsFn(clean)) return clean;

  let i = 2;
  while (existsFn(`${clean}-${i}`)) {
    i += 1;
  }
  return `${clean}-${i}`;
}

module.exports = {
  slugify,
  uniqueSlug,
};
