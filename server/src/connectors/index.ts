import { federalRegisterConnector } from "./federal_register.js";
import { gdeltConnector } from "./gdelt.js";
import { rssConnector } from "./rss.js";
import type { Connector, ConnectorType } from "./types.js";

// Connectors built so far. M2 adds cfpb_complaints, cpsc_recalls, hn_algolia,
// sam_gov, cisa_kev, and html_page.
export const connectors: Partial<Record<ConnectorType, Connector>> = {
  rss: rssConnector,
  federal_register: federalRegisterConnector,
  gdelt: gdeltConnector,
};

export function getConnector(type: ConnectorType): Connector | undefined {
  return connectors[type];
}
