#pragma once

#include <stdbool.h>

/*
 * These values describe evidence observed by a target adapter. They are kept
 * independent of ESP-IDF so the policy can be tested with a host C compiler.
 * An ACK is a positive, read-only address probe result. NO_ACK is the
 * controller's expected NACK result. ERROR means that the bus could not
 * provide a reliable answer and must never be treated as a NACK.
 */
typedef enum {
    TSX_BOARD_PROBE_NO_ACK,
    TSX_BOARD_PROBE_ACK,
    TSX_BOARD_PROBE_ERROR,
} tsx_board_probe_result_t;

typedef enum {
    TSX_BOARD_IDENTITY_MATCHED,
    TSX_BOARD_IDENTITY_MISMATCH,
    TSX_BOARD_IDENTITY_UNKNOWN,
} tsx_board_identity_state_t;

/* Bounded static identifiers suitable for UART checkpoints. */
#define TSX_BOARD_EVIDENCE_V1_FT_ACK "v1-ft-ack"
#define TSX_BOARD_EVIDENCE_V2_CST_ACK "v2-cst-ack"
#define TSX_BOARD_EVIDENCE_AMBIGUOUS_DUAL_ACK "ambiguous-dual-ack"
#define TSX_BOARD_EVIDENCE_NO_UNIQUE_ACK "no-unique-ack"
#define TSX_BOARD_EVIDENCE_PROBE_ERROR "probe-error"

typedef struct {
    tsx_board_identity_state_t state;
    const char *evidence_code;
} tsx_board_identity_t;

/*
 * Classifies the two revision probes. Only FT ACK plus a reliable CST NACK
 * can match V1. The function performs no I/O and returns static evidence
 * strings only.
 */
tsx_board_identity_t tsx_board_classify_identity(tsx_board_probe_result_t ft3168,
                                                  tsx_board_probe_result_t cst816s);

static inline bool tsx_board_identity_is_matched(tsx_board_identity_t identity)
{
    return identity.state == TSX_BOARD_IDENTITY_MATCHED;
}

/** Single static checkpoint name for a state: "pass", "mismatch" or "unknown". */
const char *tsx_board_identity_state_name(tsx_board_identity_state_t state);
