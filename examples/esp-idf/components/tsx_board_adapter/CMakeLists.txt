# The contract and classifier are shared by target adapters. The classifier has
# no ESP-IDF dependency and is also compiled by the native host fixture.
idf_component_register(SRCS "tsx_board_identity.c" INCLUDE_DIRS "include")
