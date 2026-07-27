// @codeburn/core Vercel AI Gateway provider.
//
// Two layers:
//  - Rich pure decode (`decodeVercelGateway`): host-facing, NOT part of the
//    stable minimized surface. Pure over supplied report rows; carries the
//    provider-reported dollar cost but no free text.
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export { decodeVercelGateway, type VercelGatewayDecodeInput, type VercelGatewayDecodeResult } from './decode.js'
export { toObservations, type RichVercelGatewaySessionDecode, type VercelGatewayToObservationsContext } from './observations.js'
export type { VercelGatewayDecodedCall, VercelGatewayReportRow } from './types.js'
