# The C++ demo client: wall clock -> spdlog -> superlog sink -> hub. Only in
# the build when the third_party spdlog+fmt submodules are checked out - it
# exists to prove that pin, so without it there is nothing to prove.
add_executable(superlog_clock_cpp clock.cpp)
target_link_libraries(superlog_clock_cpp PRIVATE superlog::cpp spdlog::spdlog)
target_compile_definitions(superlog_clock_cpp PRIVATE ${SUPER_LOG_MODE_DEFINES})
target_compile_options(superlog_clock_cpp PRIVATE -Wall -Wextra)
