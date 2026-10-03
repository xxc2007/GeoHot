// One error type for "the back office sent something this function cannot use". The admin handler
// maps it to 400, so an operator's typo stops being reported as a server fault (and stops being
// logged as one).
export class InvalidInput extends Error {
  readonly statusCode = 400;
}
