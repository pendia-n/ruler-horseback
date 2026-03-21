use mysql::{Pool, OptsBuilder, Opts, PooledConn};

pub fn get_conn() -> Result<PooledConn, String> {
    let opts = OptsBuilder::new()
        .ip_or_hostname(Some("127.0.0.1"))
        .tcp_port(3306)
        .user(Some("nosensetxt"))
        .pass(Some("qweasdzxc"))
        .db_name(Some("snakedesk"));

    let pool = Pool::new(Opts::from(opts)).map_err(|e| e.to_string())?;
    pool.get_conn().map_err(|e| e.to_string())
}
