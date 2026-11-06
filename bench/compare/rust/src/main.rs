// postflop-solver side of `npm run bench:compare`: the same spots, trees and
// measurement schedule as bench/compare/spots.ts. Prints one JSON line per spot.
use postflop_solver::*;
use std::time::Instant;

const OOP: &str = "AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo";
const IP: &str = "TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo";
// Pot 100, stack 200, scaled by 100 so integer chips round like 0.01 of a chip.
const SCALE: i32 = 100;

fn run(name: &str, board: &str, bets: &str, raises: &str) {
    let cards: Vec<&str> = board.split_whitespace().collect();
    let flop = flop_from_str(&cards[..3].concat()).unwrap();
    let turn = if cards.len() > 3 { card_from_str(cards[3]).unwrap() } else { NOT_DEALT };
    let river = if cards.len() > 4 { card_from_str(cards[4]).unwrap() } else { NOT_DEALT };
    let state = match cards.len() { 3 => BoardState::Flop, 4 => BoardState::Turn, _ => BoardState::River };
    let sizes = BetSizeOptions::try_from((bets, raises)).unwrap();
    let card_config = CardConfig { range: [OOP.parse().unwrap(), IP.parse().unwrap()], flop, turn, river };
    let tree_config = TreeConfig {
        initial_state: state,
        starting_pot: 100 * SCALE,
        effective_stack: 200 * SCALE,
        rake_rate: 0.0,
        rake_cap: 0.0,
        flop_bet_sizes: [sizes.clone(), sizes.clone()],
        turn_bet_sizes: [sizes.clone(), sizes.clone()],
        river_bet_sizes: [sizes.clone(), sizes],
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: 0.0,
        force_allin_threshold: 0.0,
        merging_threshold: 0.0,
    };
    let tree = ActionTree::new(tree_config).unwrap();
    let mut game = PostFlopGame::with_config(card_config, tree).unwrap();
    let (mem, _) = game.memory_usage();
    game.allocate_memory(false);
    let pot = (100 * SCALE) as f32;
    let mut solving = 0.0f64;
    let mut done: u32 = 0;
    let mut hit: [Option<(u32, f64)>; 2] = [None, None];
    let targets = [1.0f32, 0.3f32];
    let started = Instant::now();
    for i in 0..2 { solve_step(&game, i); }
    let warm = started.elapsed().as_secs_f64();
    solving += warm;
    done = 2;
    let block = Instant::now();
    for i in 2..7 { solve_step(&game, i); }
    let per_iter = block.elapsed().as_secs_f64() / 5.0;
    solving += block.elapsed().as_secs_f64();
    done = 7;
    let check = Instant::now();
    let _ = compute_exploitability(&game);
    let check_ms = check.elapsed().as_secs_f64() * 1000.0;
    while done < 1000 && hit[1].is_none() {
        let next = (done + 1).max((done as f64 * 1.15).ceil() as u32);
        let t = Instant::now();
        for i in done..next { solve_step(&game, i); }
        solving += t.elapsed().as_secs_f64();
        done = next;
        let pct = compute_exploitability(&game) / pot * 100.0;
        for k in 0..2 { if hit[k].is_none() && pct <= targets[k] { hit[k] = Some((done, solving)); } }
    }
    let json = |h: Option<(u32, f64)>| match h { Some((i, s)) => format!("[{},{:.3}]", i, s), None => "null".to_string() };
    println!(
        "{{\"spot\":\"{}\",\"mb\":{:.1},\"msPerIteration\":{:.2},\"checkMs\":{:.2},\"to1\":{},\"to03\":{},\"exploitability\":{:.5}}}",
        name, mem as f64 / 1048576.0, per_iter * 1000.0, check_ms, json(hit[0]), json(hit[1]),
        compute_exploitability(&game) / pot * 100.0
    );
}

fn main() {
    eprintln!("postflop-solver, {} threads", rayon::current_num_threads());
    let only: Vec<String> = std::env::args().skip(1).collect();
    let spots = [
        ("river", "As Kh 7d 2c 9h", "25%, 75%", "a"),
        ("turn", "As Kh 7d 2c", "25%, 75%", "a"),
        ("flop", "As Kh 7d", "50%", ""),
        ("monotone", "Ks 9s 4s", "50%", ""),
    ];
    for (name, board, bets, raises) in spots {
        if only.is_empty() || only.iter().any(|o| o == name) { run(name, board, bets, raises); }
    }
}
