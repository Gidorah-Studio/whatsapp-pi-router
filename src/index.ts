import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function whatsappPiRouter(pi: ExtensionAPI): void {
  pi.registerCommand("whatsapp-router:status", {
    description: "Show WhatsApp Pi router status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "whatsapp-pi-router scaffold is installed. Routing implementation is not enabled yet.",
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("whatsapp-router", "WhatsApp router scaffold");
  });
}
