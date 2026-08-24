! Copyright 2026 Saxon Herschel Nicholls
!
! superlog - a Fortran client for the super-log hub.
!
! Fortran is where the numerics still live, and a long-running solver is
! exactly the kind of program you cannot attach a debugger to twelve hours
! into a run. This module lets one emit its own story to the bench next to
! every other stream on it.
!
! It speaks HTTP straight down a POSIX socket through ISO_C_BINDING rather
! than linking libcurl. The house rule for every SDK here is no
! dependencies, and it matters more in Fortran than anywhere else: HPC
! sites are precisely where "just add a library" turns into a fortnight
! with the module system.
!
! Build (exactly one mode must be defined - see the #error below):
!   gfortran -cpp -DDEVELOPMENT -c superlog.F90
!
! Use:
!   use superlog
!   call sl_init(topic='fortran.solver', app='solver')
!   call sl_info('starting sweep', 'nx', '512')
!   call sl_metric('residual', res)
!   call sl_close()
!
! Wire contract: ../../docs/PROTOCOL.md

#if defined(DEVELOPMENT) && defined(PRODUCTION)
#  error "super-log: DEVELOPMENT and PRODUCTION are both defined - pick one."
#endif
#if !defined(DEVELOPMENT) && !defined(PRODUCTION)
#  error "super-log: define DEVELOPMENT or PRODUCTION (-DDEVELOPMENT). Neither is not a mode."
#endif

! What each mode forwards, as a level rank. Development shows everything;
! production defaults to OFF, because log lines leaving a production run are
! a decision for whoever owns that machine, not a default chosen here.
#ifndef SUPERLOG_DEV_POLICY
#  define SUPERLOG_DEV_POLICY 1
#endif
#ifndef SUPERLOG_PROD_POLICY
#  define SUPERLOG_PROD_POLICY 7
#endif

module superlog
  use, intrinsic :: iso_c_binding
  use, intrinsic :: iso_fortran_env, only: real64, int64
  implicit none
  private

  public :: sl_init, sl_close, sl_flush, sl_status, sl_dropped
  public :: sl_trace, sl_debug, sl_info, sl_warn, sl_error, sl_critical
  public :: sl_log, sl_metric, sl_set_trace, sl_new_trace
  public :: SL_LVL_TRACE, SL_LVL_DEBUG, SL_LVL_INFO, SL_LVL_WARN, SL_LVL_ERROR, SL_LVL_CRITICAL, SL_LVL_OFF

  integer, parameter :: SL_LVL_TRACE = 1, SL_LVL_DEBUG = 2, SL_LVL_INFO = 3
  integer, parameter :: SL_LVL_WARN = 4, SL_LVL_ERROR = 5, SL_LVL_CRITICAL = 6, SL_LVL_OFF = 7

  character(len=8), parameter :: LEVEL_NAME(6) = &
    [character(len=8) :: 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL']

  ! A solver in a tight loop can outrun a socket, so events go into a ring
  ! that drops the OLDEST when full and counts what it lost. The newest
  ! events are the ones describing whatever is going wrong right now, and a
  ! logger that blocks the computation it is observing is worse than one
  ! that admits it skipped some lines.
  integer, parameter :: MAX_LINE = 2048
  integer, parameter :: RING = 512

  character(len=MAX_LINE) :: ring_buf(RING)
  integer :: ring_head = 1, ring_count = 0
  integer(int64) :: n_dropped = 0, n_seq = 0
  integer(int64) :: rng_state = 0

  character(len=256) :: cfg_host = '127.0.0.1'
  integer :: cfg_port = 7333
  character(len=128) :: cfg_topic = 'fortran.app'
  character(len=128) :: cfg_app = 'app'
  character(len=64)  :: cfg_session = ''
  character(len=64)  :: cur_trace = ''
  integer :: min_rank = SL_LVL_OFF
  logical :: enabled = .false.
  logical :: started = .false.

  ! POSIX, bound directly. Values are identical on Linux and macOS.
  integer(c_int), parameter :: AF_INET = 2, SOCK_STREAM = 1
  integer(c_int), parameter :: SIGPIPE = 13, SIG_IGN = 1

  interface
    function c_socket(domain, typ, protocol) bind(C, name='socket') result(fd)
      import :: c_int
      integer(c_int), value :: domain, typ, protocol
      integer(c_int) :: fd
    end function

    function c_connect(fd, addr, addrlen) bind(C, name='connect') result(r)
      import :: c_int, c_char
      integer(c_int), value :: fd
      character(kind=c_char), intent(in) :: addr(*)
      integer(c_int), value :: addrlen
      integer(c_int) :: r
    end function

    function c_send(fd, buf, n, flags) bind(C, name='send') result(sent)
      import :: c_int, c_char, c_size_t, c_long
      integer(c_int), value :: fd
      character(kind=c_char), intent(in) :: buf(*)
      integer(c_size_t), value :: n
      integer(c_int), value :: flags
      integer(c_long) :: sent
    end function

    function c_close(fd) bind(C, name='close') result(r)
      import :: c_int
      integer(c_int), value :: fd
      integer(c_int) :: r
    end function

    function c_inet_addr(cp) bind(C, name='inet_addr') result(a)
      import :: c_char, c_int32_t
      character(kind=c_char), intent(in) :: cp(*)
      integer(c_int32_t) :: a
    end function

    function c_gethostbyname(nm) bind(C, name='gethostbyname') result(p)
      import :: c_char, c_ptr
      character(kind=c_char), intent(in) :: nm(*)
      type(c_ptr) :: p
    end function

    function c_setsockopt(fd, lvl, optname, optval, optlen) bind(C, name='setsockopt') result(r)
      import :: c_int, c_char
      integer(c_int), value :: fd, lvl, optname
      character(kind=c_char), intent(in) :: optval(*)
      integer(c_int), value :: optlen
      integer(c_int) :: r
    end function
  end interface

  ! struct hostent, for the case where the hub is named rather than
  ! numbered - which it usually is once the run leaves your desk.
  type, bind(C) :: hostent
    type(c_ptr) :: h_name
    type(c_ptr) :: h_aliases
    integer(c_int) :: h_addrtype
    integer(c_int) :: h_length
    type(c_ptr) :: h_addr_list
  end type

contains

  ! ------------------------------------------------------------------ setup

  subroutine sl_init(topic, app, host, port, quiet)
    character(len=*), intent(in), optional :: topic, app, host
    integer, intent(in), optional :: port
    logical, intent(in), optional :: quiet
    character(len=512) :: env
    integer :: st, dev_rank, prod_rank
    logical :: be_quiet

    be_quiet = .false.
    if (present(quiet)) be_quiet = quiet

    dev_rank = SUPERLOG_DEV_POLICY
    prod_rank = SUPERLOG_PROD_POLICY
#ifdef DEVELOPMENT
    min_rank = dev_rank
#else
    min_rank = prod_rank
#endif
    enabled = min_rank < SL_LVL_OFF

    if (present(topic)) cfg_topic = topic
    if (present(app))   cfg_app = app
    if (present(host))  cfg_host = host
    if (present(port))  cfg_port = port

    ! SUPER_LOG_URL wins, so a batch script can redirect a solver at a
    ! different bench without recompiling it.
    call get_environment_variable('SUPER_LOG_URL', env, status=st)
    if (st == 0 .and. len_trim(env) > 0) call parse_url(trim(env))

    ! A logger must never be able to kill the program it observes. If the
    ! hub goes away mid-send the write raises SIGPIPE, whose default
    ! disposition is termination - twelve hours into a run.
    call signal(SIGPIPE, SIG_IGN)

    cfg_session = session_id()
    started = .true.

    if (.not. enabled) then
      ! Say so once. An inert client looks exactly like a broken one:
      ! nothing arrives and nothing is dropped, which reads as healthy.
      if (.not. be_quiet) then
        write (0, '(a)') 'superlog: policy is OFF - nothing will be sent to ' // &
          trim(cfg_host) // ':' // itoa(cfg_port) // &
          '. Rebuild with -DSUPERLOG_PROD_POLICY=5 (ERROR) or similar to change that.'
      end if
      return
    end if
  end subroutine

  subroutine parse_url(u)
    character(len=*), intent(in) :: u
    character(len=256) :: rest
    integer :: p, c
    rest = u
    p = index(rest, '://')
    if (p > 0) rest = rest(p + 3:)
    p = index(rest, '/')
    if (p > 0) rest = rest(:p - 1)
    c = index(rest, ':', back=.true.)
    if (c > 0) then
      cfg_host = rest(:c - 1)
      read (rest(c + 1:), *, iostat=p) cfg_port
    else
      cfg_host = rest
    end if
  end subroutine

  subroutine sl_status()
    write (*, '(a)') 'superlog status'
    write (*, '(a)') '  enabled : ' // merge('yes', 'no ', enabled)
#ifdef DEVELOPMENT
    write (*, '(a)') '  mode    : development'
#else
    write (*, '(a)') '  mode    : production'
#endif
    write (*, '(a)') '  policy  : ' // trim(rank_name(min_rank))
    write (*, '(a)') '  hub     : ' // trim(cfg_host) // ':' // itoa(cfg_port)
    write (*, '(a)') '  topic   : ' // trim(cfg_topic)
    write (*, '(a)') '  session : ' // trim(cfg_session)
    write (*, '(a)') '  queued  : ' // itoa(ring_count)
    write (*, '(a)') '  dropped : ' // itoa(int(n_dropped))
  end subroutine

  function rank_name(r) result(s)
    integer, intent(in) :: r
    character(len=8) :: s
    if (r >= SL_LVL_OFF) then
      s = 'OFF'
    else
      s = LEVEL_NAME(r)
    end if
  end function

  function sl_dropped() result(n)
    integer(int64) :: n
    n = n_dropped
  end function

  ! ---------------------------------------------------------------- logging

  subroutine sl_log(level, msg, k1, v1, k2, v2)
    integer, intent(in) :: level
    character(len=*), intent(in) :: msg
    character(len=*), intent(in), optional :: k1, v1, k2, v2
    character(len=MAX_LINE) :: line
    character(len=512) :: fields

    if (.not. started) call sl_init()
    if (level < min_rank) return

    fields = ''
    if (present(k1) .and. present(v1)) then
      fields = '"' // esc(k1) // '":"' // esc(v1) // '"'
      if (present(k2) .and. present(v2)) then
        fields = trim(fields) // ',"' // esc(k2) // '":"' // esc(v2) // '"'
      end if
    end if

    line = '{"v":1,"ts":"' // now_iso8601() // '","seq":' // itoa(int(n_seq)) // &
           ',"session":"' // trim(cfg_session) // '","level":"' // trim(LEVEL_NAME(level)) // &
           '","origin":{"runtime":"fortran","app":"' // esc(trim(cfg_app)) // &
           '","platform":"' // platform_name() // '"},"msg":"' // esc(msg) // '"'
    if (len_trim(cur_trace) > 0) line = trim(line) // ',"trace":"' // trim(cur_trace) // '"'
    if (len_trim(fields) > 0)    line = trim(line) // ',"fields":{' // trim(fields) // '}'
    line = trim(line) // '}'

    n_seq = n_seq + 1
    call ring_push(line)
  end subroutine

  subroutine sl_trace(msg, k1, v1)
    character(len=*), intent(in) :: msg
    character(len=*), intent(in), optional :: k1, v1
    call sl_log(SL_LVL_TRACE, msg, k1, v1)
  end subroutine

  subroutine sl_debug(msg, k1, v1)
    character(len=*), intent(in) :: msg
    character(len=*), intent(in), optional :: k1, v1
    call sl_log(SL_LVL_DEBUG, msg, k1, v1)
  end subroutine

  subroutine sl_info(msg, k1, v1)
    character(len=*), intent(in) :: msg
    character(len=*), intent(in), optional :: k1, v1
    call sl_log(SL_LVL_INFO, msg, k1, v1)
  end subroutine

  subroutine sl_warn(msg, k1, v1)
    character(len=*), intent(in) :: msg
    character(len=*), intent(in), optional :: k1, v1
    call sl_log(SL_LVL_WARN, msg, k1, v1)
  end subroutine

  subroutine sl_error(msg, k1, v1)
    character(len=*), intent(in) :: msg
    character(len=*), intent(in), optional :: k1, v1
    call sl_log(SL_LVL_ERROR, msg, k1, v1)
  end subroutine

  subroutine sl_critical(msg, k1, v1)
    character(len=*), intent(in) :: msg
    character(len=*), intent(in), optional :: k1, v1
    call sl_log(SL_LVL_CRITICAL, msg, k1, v1)
  end subroutine

  ! Telemetry on the same pipeline - a residual, a timestep, a wall time.
  ! This is the call a solver actually wants once a run is long enough to
  ! need watching rather than reading.
  subroutine sl_metric(name, value)
    character(len=*), intent(in) :: name
    real(real64), intent(in) :: value
    character(len=MAX_LINE) :: line
    character(len=32) :: vs

    if (.not. started) call sl_init()
    if (SL_LVL_INFO < min_rank) return

    ! JSON has no NaN or Infinity, so a diverged solver would otherwise emit
    ! a line no reader can parse - which is the exact moment you need it.
    if (value /= value) then
      vs = '0'
    else if (abs(value) > huge(1.0_real64) / 2) then
      vs = '0'
    else
      write (vs, '(g0.10)') value
    end if

    line = '{"v":1,"ts":"' // now_iso8601() // '","seq":' // itoa(int(n_seq)) // &
           ',"session":"' // trim(cfg_session) // '","level":"INFO","origin":{"runtime":"fortran",' // &
           '"app":"' // esc(trim(cfg_app)) // '","platform":"' // platform_name() // &
           '"},"msg":"' // esc(name) // '","metric":{"name":"' // esc(name) // &
           '","value":' // trim(adjustl(vs)) // '}'
    if (len_trim(cur_trace) > 0) line = trim(line) // ',"trace":"' // trim(cur_trace) // '"'
    if (value /= value) line = trim(line) // ',"fields":{"value":"NaN"}'
    line = trim(line) // '}'

    n_seq = n_seq + 1
    call ring_push(line)
  end subroutine

  ! ------------------------------------------------------------- correlation

  subroutine sl_set_trace(id)
    character(len=*), intent(in) :: id
    cur_trace = id
  end subroutine

  function sl_new_trace() result(id)
    character(len=16) :: id
    id = session_id()
    cur_trace = id
  end function

  ! ------------------------------------------------------------------- ring

  subroutine ring_push(line)
    character(len=*), intent(in) :: line
    integer :: slot
    if (ring_count == RING) then
      ring_head = modulo(ring_head, RING) + 1
      n_dropped = n_dropped + 1
      ring_count = ring_count - 1
    end if
    slot = modulo(ring_head - 1 + ring_count, RING) + 1
    ring_buf(slot) = line
    ring_count = ring_count + 1
    ! Half full is the point at which a burst is likely to start costing
    ! lines, so drain before that rather than after.
    if (ring_count >= RING / 2) call sl_flush()
  end subroutine

  ! --------------------------------------------------------------- transport

  subroutine sl_flush()
    character(len=:), allocatable :: body, req
    integer :: i, slot, fd, rc
    character(kind=c_char) :: sa(16)
    integer(c_long) :: sent

    if (ring_count == 0 .or. .not. enabled) return

    body = ''
    do i = 0, ring_count - 1
      slot = modulo(ring_head - 1 + i, RING) + 1
      if (i > 0) body = body // new_line('a')
      body = body // trim(ring_buf(slot))
    end do

    fd = c_socket(AF_INET, SOCK_STREAM, 0_c_int)
    if (fd < 0) then
      ! Count and move on. Retrying inside a solver's timestep is how a
      ! logger becomes the bottleneck it was meant to diagnose.
      n_dropped = n_dropped + ring_count
      ring_count = 0; ring_head = 1
      return
    end if

    call set_timeouts(fd)

    if (.not. make_sockaddr(sa)) then
      rc = c_close(fd)
      n_dropped = n_dropped + ring_count
      ring_count = 0; ring_head = 1
      return
    end if

    if (c_connect(fd, sa, 16_c_int) /= 0) then
      rc = c_close(fd)
      n_dropped = n_dropped + ring_count
      ring_count = 0; ring_head = 1
      return
    end if

    ! Connection: close - one POST per flush. At a flush a second the
    ! handshake is free, and it means no half-open socket survives a run
    ! that ends in a scheduler kill.
    req = 'POST /ingest/' // trim(cfg_topic) // ' HTTP/1.1' // crlf() // &
          'Host: ' // trim(cfg_host) // crlf() // &
          'Content-Type: application/x-ndjson' // crlf() // &
          'Content-Length: ' // itoa(len(body)) // crlf() // &
          'Connection: close' // crlf() // crlf() // body

    sent = c_send(fd, req // c_null_char, int(len(req), c_size_t), 0_c_int)
    if (sent < 0) n_dropped = n_dropped + ring_count
    rc = c_close(fd)

    ring_count = 0
    ring_head = 1
  end subroutine

  ! A solver must not stall on a bench that has gone away, so the socket
  ! gets its own deadline rather than the kernel default of minutes.
  subroutine set_timeouts(fd)
    integer(c_int), intent(in) :: fd
    integer(c_int), parameter :: SOL_SOCKET_L = 65535, SOL_SOCKET_G = 1
    integer(c_int), parameter :: SO_SNDTIMEO_L = 4101, SO_SNDTIMEO_G = 21
    character(kind=c_char) :: tv(16)
    integer :: i, rc
    do i = 1, 16
      tv(i) = c_null_char
    end do
    tv(1) = achar(2)   ! tv_sec = 2, little-endian
#ifdef __APPLE__
    rc = c_setsockopt(fd, SOL_SOCKET_L, SO_SNDTIMEO_L, tv, 16_c_int)
#else
    rc = c_setsockopt(fd, SOL_SOCKET_G, SO_SNDTIMEO_G, tv, 16_c_int)
#endif
  end subroutine

  ! struct sockaddr_in, built by hand. It is 16 bytes on both platforms but
  ! not the same 16: BSD put a length byte where Linux keeps the high half
  ! of sin_family.
  function make_sockaddr(sa) result(ok)
    character(kind=c_char), intent(out) :: sa(16)
    logical :: ok
    integer(c_int32_t) :: addr
    integer :: i
    integer :: hi, lo

    addr = resolve(trim(cfg_host))
    if (addr == -1) then
      ok = .false.
      return
    end if

    do i = 1, 16
      sa(i) = c_null_char
    end do
#ifdef __APPLE__
    sa(1) = achar(16)
    sa(2) = achar(AF_INET)
#else
    sa(1) = achar(AF_INET)
    sa(2) = c_null_char
#endif
    ! Port in network byte order, which is the one byte-order question that
    ! has never once been answered by guessing.
    hi = ishft(cfg_port, -8)
    lo = iand(cfg_port, 255)
    sa(3) = achar(hi)
    sa(4) = achar(lo)
    do i = 0, 3
      sa(5 + i) = achar(iand(ishft(addr, -8 * i), 255))
    end do
    ok = .true.
  end function

  ! Dotted quad first, then DNS - the hub is on loopback during development
  ! and on a named box the moment the run leaves your desk.
  function resolve(h) result(addr)
    character(len=*), intent(in) :: h
    integer(c_int32_t) :: addr
    type(c_ptr) :: hp
    type(hostent), pointer :: he
    type(c_ptr), pointer :: alist(:)
    integer(c_int32_t), pointer :: first

    addr = c_inet_addr(h // c_null_char)
    if (addr /= -1) return

    hp = c_gethostbyname(h // c_null_char)
    if (.not. c_associated(hp)) then
      addr = -1
      return
    end if
    call c_f_pointer(hp, he)
    if (he%h_length /= 4 .or. .not. c_associated(he%h_addr_list)) then
      addr = -1
      return
    end if
    call c_f_pointer(he%h_addr_list, alist, [1])
    if (.not. c_associated(alist(1))) then
      addr = -1
      return
    end if
    call c_f_pointer(alist(1), first)
    addr = first
  end function

  subroutine sl_close()
    call sl_flush()
    started = .false.
  end subroutine

  ! ----------------------------------------------------------------- helpers

  function crlf() result(s)
    character(len=2) :: s
    s = achar(13) // achar(10)
  end function

  function platform_name() result(s)
    character(len=8) :: s
#ifdef __APPLE__
    s = 'macos'
#else
    s = 'linux'
#endif
  end function

  ! Every character that would otherwise end the string early or produce a
  ! line no reader can parse. Getting this wrong corrupts the whole stream,
  ! not just the offending event, because NDJSON is line-delimited.
  function esc(s) result(o)
    character(len=*), intent(in) :: s
    character(len=:), allocatable :: o
    integer :: i, c
    o = ''
    do i = 1, len_trim(s)
      c = iachar(s(i:i))
      select case (c)
      case (34);  o = o // '\"'
      case (92);  o = o // '\\'
      case (10);  o = o // '\n'
      case (13);  o = o // '\r'
      case (9);   o = o // '\t'
      case (8);   o = o // '\b'
      case (12);  o = o // '\f'
      case default
        if (c < 32) then
          o = o // '\u00' // hexbyte(c)
        else
          o = o // s(i:i)
        end if
      end select
    end do
  end function

  function hexbyte(c) result(s)
    integer, intent(in) :: c
    character(len=2) :: s
    character(len=16), parameter :: H = '0123456789abcdef'
    s = H(ishft(c, -4) + 1:ishft(c, -4) + 1) // H(iand(c, 15) + 1:iand(c, 15) + 1)
  end function

  function itoa(n) result(s)
    integer, intent(in) :: n
    character(len=:), allocatable :: s
    character(len=24) :: b
    write (b, '(i0)') n
    s = trim(adjustl(b))
  end function

  ! date_and_time reports local time plus an offset in minutes; the wire
  ! format is UTC. Rolling the offset off by hand means going through a day
  ! number, because subtracting minutes can cross a month or a year.
  function now_iso8601() result(s)
    character(len=24) :: s
    integer :: v(8), jd, mins, y, m, d
    call date_and_time(values=v)
    mins = v(5) * 60 + v(6) - v(4)
    jd = to_jdn(v(1), v(2), v(3))
    do while (mins < 0)
      mins = mins + 1440
      jd = jd - 1
    end do
    do while (mins >= 1440)
      mins = mins - 1440
      jd = jd + 1
    end do
    call from_jdn(jd, y, m, d)
    write (s, '(i4.4,"-",i2.2,"-",i2.2,"T",i2.2,":",i2.2,":",i2.2,".",i3.3,"Z")') &
      y, m, d, mins / 60, modulo(mins, 60), v(7), v(8)
  end function

  function to_jdn(y, m, d) result(jd)
    integer, intent(in) :: y, m, d
    integer :: jd, a, yy, mm
    a = (14 - m) / 12
    yy = y + 4800 - a
    mm = m + 12 * a - 3
    jd = d + (153 * mm + 2) / 5 + 365 * yy + yy / 4 - yy / 100 + yy / 400 - 32045
  end function

  subroutine from_jdn(jd, y, m, d)
    integer, intent(in) :: jd
    integer, intent(out) :: y, m, d
    integer :: a, b, c, dd, e, mm
    a = jd + 32044
    b = (4 * a + 3) / 146097
    c = a - 146097 * b / 4
    dd = (4 * c + 3) / 1461
    e = c - 1461 * dd / 4
    mm = (5 * e + 2) / 153
    d = e - (153 * mm + 2) / 5 + 1
    m = mm + 3 - 12 * (mm / 10)
    y = 100 * b + dd - 4800 + mm / 10
  end subroutine

  ! Ids come from a seeded xorshift rather than straight from the clock.
  ! system_clock's resolution is coarse enough here that consecutive calls
  ! returned ids differing in the last nibble - so two solver steps a second
  ! apart shared a trace, which is worse than having no trace at all: it
  ! silently welds two unrelated stories together.
  function next_random() result(x)
    integer(int64) :: x
    integer :: v(8)
    if (rng_state == 0) then
      call system_clock(rng_state)
      call date_and_time(values=v)
      rng_state = ieor(rng_state, int(v(8), int64) * 2654435761_int64)
      rng_state = ieor(rng_state, int(v(7) + 60 * v(6), int64) * 40503_int64)
      if (rng_state == 0) rng_state = 88172645463325252_int64
    end if
    rng_state = ieor(rng_state, ishft(rng_state, 13))
    rng_state = ieor(rng_state, ishft(rng_state, -7))
    rng_state = ieor(rng_state, ishft(rng_state, 17))
    x = rng_state
  end function

  function session_id() result(s)
    character(len=16) :: s
    integer :: i, c
    integer(int64) :: x
    character(len=16), parameter :: H = '0123456789abcdef'
    x = next_random()
    do i = 16, 1, -1
      c = int(iand(x, 15_int64)) + 1
      s(i:i) = H(c:c)
      x = ishft(x, -4)
    end do
  end function

end module superlog
