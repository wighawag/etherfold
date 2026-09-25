using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .w)],
  sockets = [(name = "http", address = "127.0.0.1:18787", http = (), service = "main")],
);
const w :Workerd.Worker = (
  modules = [(name = "worker", esModule = embed "worker.mjs")],
  compatibilityDate = "2026-08-20",
);
