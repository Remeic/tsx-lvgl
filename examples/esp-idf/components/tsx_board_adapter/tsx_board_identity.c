#include "tsx_board_identity.h"

tsx_board_identity_t tsx_board_classify_identity(tsx_board_probe_result_t ft3168,
                                                  tsx_board_probe_result_t cst816s)
{
    if (ft3168 == TSX_BOARD_PROBE_ACK && cst816s == TSX_BOARD_PROBE_ACK) {
        return (tsx_board_identity_t) {
            .state = TSX_BOARD_IDENTITY_UNKNOWN,
            .evidence_code = TSX_BOARD_EVIDENCE_AMBIGUOUS_DUAL_ACK,
        };
    }

    if (cst816s == TSX_BOARD_PROBE_ACK) {
        return (tsx_board_identity_t) {
            .state = TSX_BOARD_IDENTITY_MISMATCH,
            .evidence_code = TSX_BOARD_EVIDENCE_V2_CST_ACK,
        };
    }

    if (ft3168 == TSX_BOARD_PROBE_ACK && cst816s == TSX_BOARD_PROBE_NO_ACK) {
        return (tsx_board_identity_t) {
            .state = TSX_BOARD_IDENTITY_MATCHED,
            .evidence_code = TSX_BOARD_EVIDENCE_V1_FT_ACK,
        };
    }

    if (ft3168 == TSX_BOARD_PROBE_NO_ACK && cst816s == TSX_BOARD_PROBE_NO_ACK) {
        return (tsx_board_identity_t) {
            .state = TSX_BOARD_IDENTITY_UNKNOWN,
            .evidence_code = TSX_BOARD_EVIDENCE_NO_UNIQUE_ACK,
        };
    }

    return (tsx_board_identity_t) {
        .state = TSX_BOARD_IDENTITY_UNKNOWN,
        .evidence_code = TSX_BOARD_EVIDENCE_PROBE_ERROR,
    };
}

const char *tsx_board_identity_state_name(tsx_board_identity_state_t state)
{
    switch (state) {
        case TSX_BOARD_IDENTITY_MATCHED: return "pass";
        case TSX_BOARD_IDENTITY_MISMATCH: return "mismatch";
        case TSX_BOARD_IDENTITY_UNKNOWN: return "unknown";
    }
    return "unknown";
}
