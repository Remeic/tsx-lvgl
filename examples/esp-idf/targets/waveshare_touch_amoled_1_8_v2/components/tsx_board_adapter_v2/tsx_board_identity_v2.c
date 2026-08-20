#include "tsx_board_identity_v2.h"

tsx_board_identity_t tsx_board_classify_v2_identity(tsx_board_probe_result_t ft5x06,
                                                    tsx_board_probe_result_t cst816s)
{
    /* V2 is matched only by a unique CST-compatible ACK. A dual ACK is
     * ambiguous and must not be treated as a V2 success. */
    if (ft5x06 == TSX_BOARD_PROBE_ACK && cst816s == TSX_BOARD_PROBE_ACK) {
        return (tsx_board_identity_t) {
            .state = TSX_BOARD_IDENTITY_UNKNOWN,
            .evidence_code = TSX_BOARD_EVIDENCE_AMBIGUOUS_DUAL_ACK,
        };
    }

    if (cst816s == TSX_BOARD_PROBE_ACK && ft5x06 == TSX_BOARD_PROBE_NO_ACK) {
        return (tsx_board_identity_t) {
            .state = TSX_BOARD_IDENTITY_MATCHED,
            .evidence_code = TSX_BOARD_EVIDENCE_V2_CST_ACK,
        };
    }

    /* Any non-dual FT ACK is positive evidence of the other revision. The
     * CST result may be a NACK or an error; neither changes that mismatch. */
    if (ft5x06 == TSX_BOARD_PROBE_ACK) {
        return (tsx_board_identity_t) {
            .state = TSX_BOARD_IDENTITY_MISMATCH,
            .evidence_code = TSX_BOARD_EVIDENCE_V1_FT_ACK,
        };
    }

    if (ft5x06 == TSX_BOARD_PROBE_NO_ACK && cst816s == TSX_BOARD_PROBE_NO_ACK) {
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
