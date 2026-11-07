import { cfpbComplaintsConnector } from "./cfpb_complaints.js";
import { cisaKevConnector } from "./cisa_kev.js";
import { cpscRecallsConnector } from "./cpsc_recalls.js";
import { federalRegisterConnector } from "./federal_register.js";
import { gdeltConnector } from "./gdelt.js";
import { hnAlgoliaConnector } from "./hn_algolia.js";
import { htmlPageConnector } from "./html_page.js";
import { rssConnector } from "./rss.js";
import { samGovConnector } from "./sam_gov.js";
import type { Connector, ConnectorType } from "./types.js";

export const connectors: Record<ConnectorType, Connector> = {
  rss: rssConnector,
  federal_register: federalRegisterConnector,
  gdelt: gdeltConnector,
  cfpb_complaints: cfpbComplaintsConnector,
  cpsc_recalls: cpscRecallsConnector,
  hn_algolia: hnAlgoliaConnector,
  sam_gov: samGovConnector,
  cisa_kev: cisaKevConnector,
  html_page: htmlPageConnector,
};

export function getConnector(type: ConnectorType): Connector | undefined {
  return connectors[type];
}
