import { defineRailway, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "tsg-workforce-backend";
export default defineRailway(() => {
  const tsgWorkforceBackend = service("tsg-workforce-backend", {
    build: { buildEnvironment: "V3", builder: "NIXPACKS" },
    start: "node src/server.js",
    healthcheck: "/health",
    healthcheckTimeout: 60,
    replicas: { "sfo": 1 },
    domains: ["manpower.thesachdevgroup.com"],
  });

  return project("tsg-workforce-backend", {
    variables: { managed: false },
    resources: [tsgWorkforceBackend],
  });
});
