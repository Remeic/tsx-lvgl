#pragma once

#include "tsx_board_identity.h"

/* Pure policy function. I/O and probe ownership remain in the V2 adapter. */
tsx_board_identity_t tsx_board_classify_v2_identity(tsx_board_probe_result_t ft5x06,
                                                    tsx_board_probe_result_t cst816s);
