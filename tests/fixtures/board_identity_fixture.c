#include "tsx_board_identity.h"

#include <assert.h>
#include <string.h>

static void expect_identity(tsx_board_probe_result_t ft3168,
                            tsx_board_probe_result_t cst816s,
                            tsx_board_identity_state_t state,
                            const char *evidence_code)
{
    const tsx_board_identity_t identity = tsx_board_classify_identity(ft3168, cst816s);
    assert(identity.state == state);
    assert(identity.evidence_code != NULL);
    assert(strcmp(identity.evidence_code, evidence_code) == 0);
}

int main(void)
{
    expect_identity(TSX_BOARD_PROBE_ACK, TSX_BOARD_PROBE_NO_ACK,
                    TSX_BOARD_IDENTITY_MATCHED, TSX_BOARD_EVIDENCE_V1_FT_ACK);
    expect_identity(TSX_BOARD_PROBE_NO_ACK, TSX_BOARD_PROBE_ACK,
                    TSX_BOARD_IDENTITY_MISMATCH, TSX_BOARD_EVIDENCE_V2_CST_ACK);
    expect_identity(TSX_BOARD_PROBE_ERROR, TSX_BOARD_PROBE_ACK,
                    TSX_BOARD_IDENTITY_MISMATCH, TSX_BOARD_EVIDENCE_V2_CST_ACK);
    expect_identity(TSX_BOARD_PROBE_ACK, TSX_BOARD_PROBE_ACK,
                    TSX_BOARD_IDENTITY_UNKNOWN, TSX_BOARD_EVIDENCE_AMBIGUOUS_DUAL_ACK);
    expect_identity(TSX_BOARD_PROBE_NO_ACK, TSX_BOARD_PROBE_NO_ACK,
                    TSX_BOARD_IDENTITY_UNKNOWN, TSX_BOARD_EVIDENCE_NO_UNIQUE_ACK);
    expect_identity(TSX_BOARD_PROBE_ERROR, TSX_BOARD_PROBE_NO_ACK,
                    TSX_BOARD_IDENTITY_UNKNOWN, TSX_BOARD_EVIDENCE_PROBE_ERROR);
    expect_identity(TSX_BOARD_PROBE_ACK, TSX_BOARD_PROBE_ERROR,
                    TSX_BOARD_IDENTITY_UNKNOWN, TSX_BOARD_EVIDENCE_PROBE_ERROR);
    expect_identity(TSX_BOARD_PROBE_NO_ACK, TSX_BOARD_PROBE_ERROR,
                    TSX_BOARD_IDENTITY_UNKNOWN, TSX_BOARD_EVIDENCE_PROBE_ERROR);
    expect_identity(TSX_BOARD_PROBE_ERROR, TSX_BOARD_PROBE_ERROR,
                    TSX_BOARD_IDENTITY_UNKNOWN, TSX_BOARD_EVIDENCE_PROBE_ERROR);
    return 0;
}
