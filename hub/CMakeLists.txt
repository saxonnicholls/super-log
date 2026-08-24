# superlogd - the hub daemon. Everything hard is in ts-moveables.
add_executable(superlogd src/main.cpp)
# So /healthz can say which build is answering - "did it restart, and with
# what" is the first question when the numbers look wrong.
target_compile_definitions(superlogd PRIVATE
    SUPERLOG_VERSION="${PROJECT_VERSION}")
target_link_libraries(superlogd PRIVATE snicholls::ts_moveables)
target_compile_features(superlogd PRIVATE cxx_std_17)
target_compile_options(superlogd PRIVATE -Wall -Wextra)
