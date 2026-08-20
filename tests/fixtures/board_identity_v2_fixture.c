#include "tsx_board_identity_v2.h"

#include <assert.h>
#include <string.h>

static void expect_identity(tsx_board_probe_result_t ft5x06,
                            tsx_board_probe_result_t cst816s,
                            tsx_board_identity_state_t state,
                            const char *evidence_code)
{
    const tsx_board_identity_t identity = tsx_board_classify_v2_identity(ft5x06, cst816s);
    assert(identity.state == state);
    assert(identity.evidence_code != NULL);
    assert(strcmp(identity.evidence_code, evidence_code) == 0);
}

int main(void)
{
    /* V2 requires the unique CST-compatible ACK. */
    expect_identity(TSX_BOARD_PROBE_NO_ACK, TSX_BOARD_PROBE_ACK,
                    TSX_BOARD_IDENTITY_MATCHED, TSX_BOARD_EVIDENCE_V2_CST_ACK);
    /* Any FT ACK is a V1 mismatch unless both addresses ACK. */
    expect_identity(TSX_BOARD_PROBE_ACK, TSX_BOARD_PROBE_NO_ACK,
                    TSX_BOARD_IDENTITY_MISMATCH, TSX_BOARD_EVIDENCE_V1_FT_ACK);
    expect_identity(TSX_BOARD_PROBE_ACK, TSX_BOARD_PROBE_ERROR,
                    TSX_BOARD_IDENTITY_MISMATCH, TSX_BOARD_EVIDENCE_V1_FT_ACK);
    expect_identity(TSX_BOARD_PROBE_ACK, TSX_BOARD_PROBE_ACK,
                    TSX_BOARD_IDENTITY_UNKNOWN, TSX_BOARD_EVIDENCE_AMBIGUOUS_DUAL_ACK);
    /* No unique positive evidence fails closed as unknown. */
    expect_identity(TSX_BOARD_PROBE_NO_ACK, TSX_BOARD_PROBE_NO_ACK,
                    TSX_BOARD_IDENTITY_UNKNOWN, TSX_BOARD_EVIDENCE_NO_UNIQUE_ACK);
    expect_identity(TSX_BOARD_PROBE_ERROR, TSX_BOARD_PROBE_ACK,
                    TSX_BOARD_IDENTITY_UNKNOWN, TSX_BOARD_EVIDENCE_PROBE_ERROR);
    expect_identity(TSX_BOARD_PROBE_NO_ACK, TSX_BOARD_PROBE_ERROR,
                    TSX_BOARD_IDENTITY_UNKNOWN, TSX_BOARD_EVIDENCE_PROBE_ERROR);
    expect_identity(TSX_BOARD_PROBE_ERROR, TSX_BOARD_PROBE_ERROR,
                    TSX_BOARD_IDENTITY_UNKNOWN, TSX_BOARD_EVIDENCE_PROBE_ERROR);
    return 0;
}
