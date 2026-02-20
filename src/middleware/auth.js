function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.flash = { type: "error", text: "Tenes que iniciar sesion para entrar al panel." };
    return res.redirect("/login");
  }
  next();
}

function requireRole(roles) {
  const accepted = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    if (!req.session.user) {
      req.session.flash = { type: "error", text: "Tenes que iniciar sesion para continuar." };
      return res.redirect("/login");
    }
    if (!accepted.includes(req.session.user.role)) {
      req.session.flash = { type: "error", text: "No tenes permisos para esa seccion." };
      const role = req.session.user.role;
      if (role === "ADMIN") return res.redirect("/admin/affiliate-sales");
      if (role === "AFFILIATE") return res.redirect("/afiliados/panel");
      return res.redirect("/app");
    }
    return next();
  };
}

module.exports = {
  requireAuth,
  requireRole,
};
