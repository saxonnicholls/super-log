# superlogd - the hub daemon. Everything hard is in ts-moveables.
add_executable(superlogd src/main.cpp)
target_link_libraries(superlogd PRIVATE snicholls::ts_moveables)
target_compile_features(superlogd PRIVATE cxx_std_17)
target_compile_options(superlogd PRIVATE -Wall -Wextra)
